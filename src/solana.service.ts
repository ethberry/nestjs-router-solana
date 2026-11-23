import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoggerService } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { MessageHandler } from "@nestjs/microservices";
import { transformPatternToRoute } from "@nestjs/microservices/utils/index.js";
import { PATTERN_METADATA } from "@nestjs/microservices/constants";
import { SchedulerRegistry } from "@nestjs/schedule";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { CronJob } from "cron";
import { EMPTY, from, Observable, Subject } from "rxjs";
import { finalize, mergeAll, mergeMap } from "rxjs/operators";

import { getTransfers } from "./utils/get-transfers.js";
import { BLOCK_EVENT, SOLANA_RPC, SolanaEventType } from "./solana.constants.js";
import { MODULE_OPTIONS_TOKEN } from "./solana.module-definition.js";
import type {
  IBlockEvent,
  IContractOptions,
  IDiscoveredHandler,
  ILogEvent,
  ISolanaModuleOptions,
  ISolanaTransaction,
  ITransfer,
} from "./interfaces/index.js";

const blockPattern = { eventName: BLOCK_EVENT };

// an event on its way to the handlers
interface IRoutedEvent {
  pattern: Record<string, string>;
  description: ILogEvent;
  context: unknown;
}

@Injectable()
export class SolanaService {
  private instanceId: string;
  private cronLock = false;
  private lastProcessedSlot = -1n;
  private registry: IContractOptions[] = [];
  private subject = new Subject<IRoutedEvent>();
  // events emitted whose handlers have not finished, and who waits for that number to reach 0
  private pending = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(
    @Inject(Logger)
    protected readonly loggerService: LoggerService,
    @Inject(SOLANA_RPC)
    protected readonly rpc: Rpc<SolanaRpcApi>,
    protected readonly discoveryService: DiscoveryService,
    protected readonly metadataScanner: MetadataScanner,
    protected readonly reflector: Reflector,
    @Inject(MODULE_OPTIONS_TOKEN)
    protected options: ISolanaModuleOptions,
    protected schedulerRegistry: SchedulerRegistry,
  ) {
    // handlers run one at a time, in the order of the chain
    this.subject
      .pipe(
        mergeMap(
          ({ pattern, description, context }) =>
            from(this.call(pattern, description, context)).pipe(
              mergeAll(),
              finalize(() => this.settle()),
            ),
          1,
        ),
      )
      .subscribe({
        next: v => {
          loggerService.log(v, `${SolanaService.name}-${this.instanceId}`);
        },
        error: e => {
          loggerService.error(e);
        },
      });
  }

  public init(): void {
    this.instanceId = (Math.random() + 1).toString(36).substring(7);
    const job = new CronJob(this.options.cron, async () => {
      // if the previous run is still going - skip
      if (this.cronLock) {
        return;
      }
      this.cronLock = true;
      await this.listen().catch(e => this.loggerService.error(e, `${SolanaService.name}-${this.instanceId}`));
      this.cronLock = false;
    });
    this.schedulerRegistry.addCronJob(`solanaListener_${this.instanceId}`, job);
    job.start();
  }

  // Reads the next range of slots up to the head at the commitment and hands every transfer to the handlers.
  // The cursor moves only after all handlers of the range have finished; then the block event reports it.
  public async listen(): Promise<void> {
    if (!this.registry.length) {
      return;
    }

    const commitment = this.options.commitment ?? "finalized";
    const head = await this.rpc.getSlot({ commitment }).send();
    let fromSlot = this.options.fromSlot;
    if (fromSlot > head) {
      return;
    }

    // the node keeps only recent blocks; getBlocks below the first one silently starts at it
    const firstAvailable = await this.rpc.getFirstAvailableBlock().send();
    if (fromSlot < firstAvailable) {
      this.loggerService.error(
        `Slots ${fromSlot}..${firstAvailable - 1n} are no longer on the node; their transfers are not read`,
        `${SolanaService.name}-${this.instanceId}`,
      );
      fromSlot = firstAvailable;
    }

    const chunkSize = BigInt(this.options.chunkSize ?? 1000);
    const toSlot = head < fromSlot + chunkSize - 1n ? head : fromSlot + chunkSize - 1n;
    // only the slots that have a block: a leader may skip its slot
    const slots = await this.rpc.getBlocks(fromSlot, toSlot, { commitment }).send();

    for (const slot of slots) {
      const block = await this.rpc
        .getBlock(slot, {
          commitment,
          encoding: "jsonParsed",
          transactionDetails: "full",
          maxSupportedTransactionVersion: 0,
          rewards: false,
        })
        .send();
      for (const tx of block?.transactions ?? []) {
        this.route(slot, tx);
      }
    }

    await this.drained();
    this.lastProcessedSlot = toSlot;
    this.options.fromSlot = toSlot + 1n;
    await this.emitBlock(toSlot);
  }

  public updateRegistry(contract: IContractOptions): void {
    const entry = this.registry.find(e => e.contractType === contract.contractType);

    if (entry) {
      entry.contractAddress = [...new Set([...entry.contractAddress, ...contract.contractAddress])];
    } else {
      this.registry.push(contract);
    }

    this.loggerService.log(
      `Solana listener updated: ${contract.contractAddress.join(", ")}`,
      `${SolanaService.name}-${this.instanceId}`,
    );
  }

  public getRegistry(): IContractOptions[] {
    return this.registry;
  }

  // the last slot whose transfers have all been handled, -1 before the first range
  public getLastProcessedSlot(): bigint {
    return this.lastProcessedSlot;
  }

  public destroy(): void {
    this.subject.complete();
  }

  protected getHandlerByPattern<T extends Array<Record<string, string>>>(route: string): Array<IDiscoveredHandler<T>> {
    const methods: Array<IDiscoveredHandler<T>> = [];
    for (const wrapper of this.discoveryService.getControllers()) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== "object") {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== "function") {
          continue;
        }
        const meta = this.reflector.get<T | undefined>(PATTERN_METADATA, handler);
        if (meta) {
          methods.push({ meta, methodName, handler: handler as IDiscoveredHandler<T>["handler"], instance });
        }
      }
    }
    return methods.filter(method => method.meta.some(meta => transformPatternToRoute(meta) === route));
  }

  protected async call(
    pattern: Record<string, string>,
    description: ILogEvent,
    context: unknown,
  ): Promise<Observable<any>> {
    const route = transformPatternToRoute(pattern);
    const handlers = this.getHandlerByPattern(route);

    if (!handlers.length) {
      this.loggerService.log(`Handler not found for: ${route}`, `${SolanaService.name}-${this.instanceId}`);
      return EMPTY;
    }

    const results = await Promise.allSettled(
      handlers.map(({ handler, instance }) => (handler.bind(instance) as MessageHandler)(description, context)),
    );
    results.forEach(result => {
      if (result.status === "rejected") {
        this.loggerService.error(result.reason, `${SolanaService.name}-${this.instanceId}`);
      }
    });
    return from(["OK"]);
  }

  // A transaction that names a watched address (any account key, or the owner of a token balance it changes) goes,
  // with all its transfers, to the handlers of that address's contractType: once per contractType
  private route(slot: bigint, tx: ISolanaTransaction): void {
    const transfers = getTransfers(tx);
    if (!transfers.length) {
      return;
    }

    const named = new Set([
      ...tx.transaction.message.accountKeys.map(key => key.pubkey),
      ...transfers.map(t => t.owner),
    ]);
    const signature = tx.transaction.signatures[0];

    for (const entry of this.registry) {
      if (!entry.contractAddress.some(address => named.has(address))) {
        continue;
      }
      for (const transfer of transfers) {
        const args: ITransfer = { ...transfer, slot, signature };
        this.emit({
          pattern: { contractType: entry.contractType, eventName: SolanaEventType.TRANSFER },
          description: { name: SolanaEventType.TRANSFER, args },
          context: tx,
        });
      }
    }
  }

  private async emitBlock(slot: bigint): Promise<void> {
    if (!this.getHandlerByPattern(transformPatternToRoute(blockPattern)).length) {
      return;
    }
    const args: IBlockEvent = { slot };
    this.emit({ pattern: blockPattern, description: { name: BLOCK_EVENT, args }, context: args });
    await this.drained();
  }

  private emit(event: IRoutedEvent): void {
    this.pending++;
    this.subject.next(event);
  }

  // an emitted event's handlers have finished
  private settle(): void {
    this.pending--;
    if (!this.pending) {
      this.drainWaiters.splice(0).forEach(resolve => resolve());
    }
  }

  // resolves when the handlers of every emitted event have finished
  private drained(): Promise<void> {
    if (!this.pending) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.drainWaiters.push(resolve));
  }
}
