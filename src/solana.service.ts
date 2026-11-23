import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoggerService } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { MessageHandler } from "@nestjs/microservices";
import { transformPatternToRoute } from "@nestjs/microservices/utils/index.js";
import { PATTERN_METADATA } from "@nestjs/microservices/constants";
import { SchedulerRegistry } from "@nestjs/schedule";
import type { Commitment, Rpc, SolanaRpcApi } from "@solana/kit";
import { CronJob } from "cron";

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
// slots per run: about 40 s of chain, also the most a failed run reads again
const DEFAULT_CHUNK_SIZE = 100;
// the longest pause after failed runs, in cron ticks
// (a node outage is retried at least every 16 ticks once it is over)
const MAX_SKIPPED_TICKS = 15;

// an event on its way to the handlers
interface IRoutedEvent {
  pattern: Record<string, string>;
  description: ILogEvent;
  context: unknown;
}

@Injectable()
export class SolanaService {
  private instanceId = (Math.random() + 1).toString(36).substring(7);
  private job?: CronJob;
  private running = false;
  private destroyed = false;
  // failed runs in a row, and the cron ticks still to skip after them
  private failures = 0;
  private skippedTicks = 0;
  private lastProcessedSlot = -1n;
  private registry: IContractOptions[] = [];

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
  ) {}

  // A run per cron tick. After a failed run the next ones are skipped, doubling (1, 3, 7… up to MAX_SKIPPED_TICKS
  // ticks), so a handler that keeps failing on one event does not hammer the node; every failure is logged with its
  // count. A successful run resets it.
  public init(): void {
    this.job = new CronJob(this.options.cron, async () => {
      // a run the app started itself is still going: not a run of this tick, it changes nothing
      if (this.running) {
        return;
      }
      if (this.skippedTicks > 0) {
        this.skippedTicks--;
        return;
      }
      await this.listen().then(
        () => {
          this.failures = 0;
        },
        (e: unknown) => {
          this.failures++;
          this.skippedTicks = Math.min(2 ** this.failures - 1, MAX_SKIPPED_TICKS);
          this.loggerService.error(
            `Run failed ${this.failures} time(s) in a row, next try in ${this.skippedTicks + 1} tick(s): ${String(e)}`,
            `${SolanaService.name}-${this.instanceId}`,
          );
        },
      );
    });
    this.schedulerRegistry.addCronJob(`solanaListener_${this.instanceId}`, this.job);
    this.job.start();
  }

  // Reads the next range of slots up to the head at the commitment and hands every transfer to the handlers, one at a
  // time in chain order. The whole range is read before any handler runs, so a node error delivers nothing. The first
  // failing handler stops the run: it throws, the cursor stays, and the next run reads the same range again from its
  // start, so the order holds and handlers must be idempotent (by signature). Only one run at a time: a call while a
  // run is going returns at once.
  public async listen(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      if (!this.registry.length) {
        return;
      }

      const commitment = this.options.commitment ?? "finalized";
      const head = await this.rpc.getSlot({ commitment }).send();
      const fromSlot = this.options.fromSlot;
      if (fromSlot > head) {
        return;
      }

      const chunkSize = BigInt(this.options.chunkSize ?? DEFAULT_CHUNK_SIZE);
      const toSlot = head < fromSlot + chunkSize - 1n ? head : fromSlot + chunkSize - 1n;
      // only the slots that have a block: a leader may skip its slot
      const slots = await this.rpc.getBlocks(fromSlot, toSlot, { commitment }).send();

      // A node that keeps only recent blocks answers getBlocks below its first one from that first one, silently. A node
      // with full history (a BigTable-backed provider) returns the older slots; then nothing is missing.
      const firstAvailable = await this.rpc.getFirstAvailableBlock().send();
      if (fromSlot < firstAvailable && !(slots.length && slots[0] < firstAvailable)) {
        throw new Error(
          `Slots ${fromSlot}..${firstAvailable - 1n} are no longer on the node: reading stops here. Read them from a node ` +
            `with full history, or move the cursor (fromSlot) on purpose.`,
        );
      }

      // A handler can add to the registry while the range is processed (a deploy adds a new address): after a pass and all
      // its handlers, the range is read again for the addresses that appeared during it, until none appears. A
      // transaction goes to a contract type once per range, also when it names several of its addresses.
      const read = new Set<string>();
      const delivered = new Set<string>();
      let pass = this.notRead(read);
      while (pass.length) {
        const events = await this.readRange(slots, commitment, pass, delivered);
        for (const event of events) {
          if (this.destroyed) {
            return;
          }
          if (!(await this.call(event))) {
            throw new Error(
              `A handler failed in slots ${fromSlot}..${toSlot}: the range is read again on the next run`,
            );
          }
        }
        pass = this.notRead(read);
      }

      if (this.destroyed) {
        return;
      }
      const args: IBlockEvent = { slot: toSlot };
      const blockEvent = { pattern: blockPattern, description: { name: BLOCK_EVENT, args }, context: args };
      if (this.hasHandler(blockPattern) && !(await this.call(blockEvent))) {
        throw new Error(`The block handler failed for slot ${toSlot}: the range is read again on the next run`);
      }
      this.lastProcessedSlot = toSlot;
      this.options.fromSlot = toSlot + 1n;
    } finally {
      this.running = false;
    }
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

  // Stops the cron job; a run in progress stops before its next handler and does not move the cursor
  public destroy(): void {
    this.destroyed = true;
    if (this.job) {
      void this.job.stop();
      this.schedulerRegistry.deleteCronJob(`solanaListener_${this.instanceId}`);
    }
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

  // Runs every handler of the event; true when all succeeded. A handler that throws (also synchronously) or rejects is
  // logged and does not stop the others.
  protected async call({ pattern, description, context }: IRoutedEvent): Promise<boolean> {
    const route = transformPatternToRoute(pattern);
    const handlers = this.getHandlerByPattern(route);

    if (!handlers.length) {
      this.loggerService.log(`Handler not found for: ${route}`, `${SolanaService.name}-${this.instanceId}`);
      return true;
    }

    const results = await Promise.allSettled(
      handlers.map(({ handler, instance }) =>
        Promise.resolve().then(() => (handler.bind(instance) as MessageHandler)(description, context)),
      ),
    );
    let ok = true;
    for (const result of results) {
      if (result.status === "rejected") {
        ok = false;
        this.loggerService.error(result.reason, `${SolanaService.name}-${this.instanceId}`);
      }
    }
    return ok;
  }

  private hasHandler(pattern: Record<string, string>): boolean {
    return this.getHandlerByPattern(transformPatternToRoute(pattern)).length > 0;
  }

  // the part of the registry this range has not read yet: per entry, its addresses not read; marks them read
  private notRead(read: Set<string>): IContractOptions[] {
    const pass: IContractOptions[] = [];
    for (const entry of this.registry) {
      const contractAddress = entry.contractAddress.filter(address => !read.has(`${entry.contractType} ${address}`));
      contractAddress.forEach(address => read.add(`${entry.contractType} ${address}`));
      if (contractAddress.length) {
        pass.push({ ...entry, contractAddress });
      }
    }
    return pass;
  }

  // The events of the given slots for the given part of the registry, in chain order. A slot listed by getBlocks
  // whose block the node does not return is an error: skipping it would lose its transfers.
  private async readRange(
    slots: readonly bigint[],
    commitment: Commitment,
    registry: IContractOptions[],
    delivered: Set<string>,
  ): Promise<IRoutedEvent[]> {
    const events: IRoutedEvent[] = [];
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
      if (!block) {
        throw new Error(`Block ${slot} is not available on the node`);
      }
      for (const tx of block.transactions) {
        events.push(...this.route(slot, tx, registry, delivered));
      }
    }
    return events;
  }

  // A transaction that names a watched address (any account key, or the owner of a token balance it changes) goes,
  // with all its transfers, to the handlers of that address's contractType: once per contractType and range
  private route(
    slot: bigint,
    tx: ISolanaTransaction,
    registry: IContractOptions[],
    delivered: Set<string>,
  ): IRoutedEvent[] {
    const transfers = getTransfers(tx);
    if (!transfers.length) {
      return [];
    }

    const named = new Set([
      ...tx.transaction.message.accountKeys.map(key => key.pubkey),
      ...transfers.map(t => t.owner),
    ]);
    const signature = tx.transaction.signatures[0];

    const events: IRoutedEvent[] = [];
    for (const entry of registry) {
      const key = `${entry.contractType} ${signature}`;
      if (delivered.has(key) || !entry.contractAddress.some(address => named.has(address))) {
        continue;
      }
      delivered.add(key);
      for (const transfer of transfers) {
        const args: ITransfer = { ...transfer, slot, signature };
        events.push({
          pattern: { contractType: entry.contractType, eventName: SolanaEventType.TRANSFER },
          description: { name: SolanaEventType.TRANSFER, args },
          context: tx,
        });
      }
    }
    return events;
  }
}
