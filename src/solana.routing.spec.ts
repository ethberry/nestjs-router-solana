// The read cycle and routing of SolanaService on a fake chain: the RPC is stubbed with blocks built here, so each case
// controls exactly which transactions are in which slot.
import { jest } from "@jest/globals";
import { Controller, Injectable, Logger } from "@nestjs/common";
import type { Type } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression } from "@nestjs/schedule";

import { BLOCK_EVENT, SOLANA_RPC, SolanaEventType } from "./solana.constants.js";
import type { IBlockEvent, ILogEvent, ISolanaTransaction, ITransfer } from "./interfaces/index.js";
import { SolanaModule } from "./solana.module.js";
import { SolanaService } from "./solana.service.js";

const PAYER = "Payer111111111111111111111111111111111111111";
const MERCHANT = "Merchant11111111111111111111111111111111111";
const SHOP = "Shop111111111111111111111111111111111111111";
const DEPLOYED = "Deployed11111111111111111111111111111111111";
const FEE = 5000n;

enum ContractType {
  MERCHANT = "MERCHANT",
  SHOP = "SHOP",
  DEPLOYED = "DEPLOYED",
}

// A native transfer as getBlock returns it: `from` pays `amount` and the fee, every key in `to` receives `amount`
function solTransfer(signature: string, from: string, to: string[], amount: bigint): ISolanaTransaction {
  return {
    transaction: {
      signatures: [signature],
      message: { accountKeys: [from, ...to].map(pubkey => ({ pubkey })), instructions: [] },
    },
    meta: {
      err: null,
      fee: FEE,
      preBalances: [10_000_000n, ...to.map(() => 0n)],
      postBalances: [10_000_000n - amount * BigInt(to.length) - FEE, ...to.map(() => amount)],
    },
  };
}

// The RPC of a chain whose head is `head` and whose produced slots hold the given transactions
function fakeChain(head: bigint, blocks: Record<string, ISolanaTransaction[]>) {
  const slotsOf = (from: bigint, to: bigint) =>
    Object.keys(blocks)
      .map(BigInt)
      .filter(slot => slot >= from && slot <= to);
  const rpc = {
    getSlot: () => ({ send: () => Promise.resolve(head) }),
    getFirstAvailableBlock: () => ({ send: () => Promise.resolve(0n) }),
    getBlocks: jest.fn((from: bigint, to: bigint) => ({ send: () => Promise.resolve(slotsOf(from, to)) })),
    getBlock: jest.fn((slot: bigint) => ({
      send: () => Promise.resolve({ transactions: blocks[String(slot)] ?? [] }),
    })),
  };
  return rpc;
}

@Injectable()
class Received {
  // in the order the handlers ran: "<contractType> <signature> <owner>" or "block <slot>"
  public log: string[] = [];
}

@Controller()
class RecordingController {
  constructor(private readonly received: Received) {}

  @EventPattern(
    [ContractType.MERCHANT, ContractType.SHOP, ContractType.DEPLOYED].map(contractType => ({
      contractType,
      eventName: SolanaEventType.TRANSFER,
    })),
  )
  public transfer(@Payload() event: ILogEvent<ITransfer>): void {
    this.received.log.push(`${event.args.signature} ${event.args.owner} ${event.args.amount}`);
  }

  @EventPattern({ eventName: BLOCK_EVENT })
  public block(@Payload() event: ILogEvent<IBlockEvent>): void {
    this.received.log.push(`block ${event.args.slot}`);
  }
}

// Records per contract type
@Controller()
class TypedController {
  constructor(private readonly received: Received) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: SolanaEventType.TRANSFER })
  public merchant(@Payload() event: ILogEvent<ITransfer>): void {
    this.received.log.push(`MERCHANT ${event.args.signature} ${event.args.owner}`);
  }

  @EventPattern({ contractType: ContractType.SHOP, eventName: SolanaEventType.TRANSFER })
  public shop(@Payload() event: ILogEvent<ITransfer>): void {
    this.received.log.push(`SHOP ${event.args.signature} ${event.args.owner}`);
  }

  @EventPattern({ contractType: ContractType.DEPLOYED, eventName: SolanaEventType.TRANSFER })
  public deployed(@Payload() event: ILogEvent<ITransfer>): void {
    this.received.log.push(`DEPLOYED ${event.args.signature} ${event.args.owner}`);
  }
}

// A merchant transfer "deploys" a new address: the handler registers it, as a factory event handler does on EVM
@Controller()
class RegisteringController {
  constructor(private readonly solanaService: SolanaService) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: SolanaEventType.TRANSFER })
  public merchant(): void {
    this.solanaService.updateRegistry({ contractType: ContractType.DEPLOYED, contractAddress: [DEPLOYED] });
  }
}

// The first of two handlers of one pattern always fails
@Controller()
class FailingController {
  @EventPattern({ contractType: ContractType.MERCHANT, eventName: SolanaEventType.TRANSFER })
  public merchant(): Promise<void> {
    return Promise.reject(new Error("handler failed"));
  }
}

async function reader(
  rpc: ReturnType<typeof fakeChain>,
  controllers: Array<Type<unknown>>,
  fromSlot = 1n,
  chunkSize = 1000,
) {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      SolanaModule.register({ fromSlot, chunkSize, debug: false, cron: CronExpression.EVERY_HOUR }),
    ],
    providers: [Received],
    controllers,
  })
    .overrideProvider(SOLANA_RPC)
    .useValue(rpc)
    .compile();
  const logger = module.get(Logger);
  jest.spyOn(logger, "log").mockImplementation(() => undefined);
  const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
  return { service: module.get(SolanaService), received: module.get(Received), error };
}

describe("SolanaService routing", function () {
  it("delivers a transfer of a watched address with its slot, signature, owner, asset and signed amount", async function () {
    const rpc = fakeChain(10n, { 5: [solTransfer("s1", PAYER, [MERCHANT], 1000n)] });
    const { service, received } = await reader(rpc, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    await service.listen();

    expect(received.log).toEqual(["s1 " + PAYER + " -1000", "s1 " + MERCHANT + " 1000", "block 10"]);
  });

  it("delivers nothing for a transaction that names no watched address", async function () {
    const rpc = fakeChain(10n, { 5: [solTransfer("s1", PAYER, [SHOP], 1000n)] });
    const { service, received } = await reader(rpc, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    await service.listen();

    expect(received.log).toEqual(["block 10"]);
  });

  it("matches base58 addresses exactly: another letter case is another address", async function () {
    const rpc = fakeChain(10n, { 5: [solTransfer("s1", PAYER, [MERCHANT], 1000n)] });
    const { service, received } = await reader(rpc, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toLowerCase()] });

    await service.listen();

    expect(received.log).toEqual(["block 10"]);
  });

  it("delivers a transaction that names two addresses of one contract type once", async function () {
    const rpc = fakeChain(10n, { 5: [solTransfer("s1", PAYER, [MERCHANT, SHOP], 1000n)] });
    const { service, received } = await reader(rpc, [TypedController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT, SHOP] });

    await service.listen();

    expect(received.log).toEqual([`MERCHANT s1 ${PAYER}`, `MERCHANT s1 ${MERCHANT}`, `MERCHANT s1 ${SHOP}`]);
  });

  it("delivers a transaction to every contract type that watches one of its addresses", async function () {
    const rpc = fakeChain(10n, { 5: [solTransfer("s1", PAYER, [MERCHANT], 1000n)] });
    const { service, received } = await reader(rpc, [TypedController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });
    service.updateRegistry({ contractType: ContractType.SHOP, contractAddress: [MERCHANT] });

    await service.listen();

    expect(received.log).toEqual([
      `MERCHANT s1 ${PAYER}`,
      `MERCHANT s1 ${MERCHANT}`,
      `SHOP s1 ${PAYER}`,
      `SHOP s1 ${MERCHANT}`,
    ]);
  });

  it("merges the addresses of one contract type, without duplicates", async function () {
    const { service } = await reader(fakeChain(10n, {}), []);

    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [SHOP, MERCHANT] });

    expect(service.getRegistry()).toEqual([{ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT, SHOP] }]);
  });

  it("delivers the transfers of an address a handler registers during the range, from the whole range, once", async function () {
    const rpc = fakeChain(10n, {
      // before the merchant transfer that "deploys" it, and after it
      4: [solTransfer("before", PAYER, [DEPLOYED], 10n)],
      5: [solTransfer("deploy", PAYER, [MERCHANT], 1000n)],
      6: [solTransfer("after", PAYER, [DEPLOYED], 20n)],
    });
    const { service, received } = await reader(rpc, [RegisteringController, TypedController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    await service.listen();

    expect(received.log).toEqual([
      `MERCHANT deploy ${PAYER}`,
      `MERCHANT deploy ${MERCHANT}`,
      `DEPLOYED before ${PAYER}`,
      `DEPLOYED before ${DEPLOYED}`,
      `DEPLOYED after ${PAYER}`,
      `DEPLOYED after ${DEPLOYED}`,
    ]);
    // one pass for the registry, one more for the address that appeared; a third finds nothing new
    expect(rpc.getBlock).toHaveBeenCalledTimes(6);
  });

  it("emits the block event after every handler of the range, with the range's last slot", async function () {
    const rpc = fakeChain(10n, {
      5: [solTransfer("s1", PAYER, [MERCHANT], 1n)],
      7: [solTransfer("s2", PAYER, [MERCHANT], 2n)],
    });
    const { service, received } = await reader(rpc, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    await service.listen();

    expect(received.log).toEqual([
      `s1 ${PAYER} -1`,
      `s1 ${MERCHANT} 1`,
      `s2 ${PAYER} -2`,
      `s2 ${MERCHANT} 2`,
      "block 10",
    ]);
    expect(service.getLastProcessedSlot()).toEqual(10n);
  });

  it("moves the cursor without a block handler", async function () {
    const rpc = fakeChain(10n, {});
    const { service } = await reader(rpc, [TypedController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    await service.listen();

    expect(service.getLastProcessedSlot()).toEqual(10n);
  });

  it("reads nothing while the registry is empty", async function () {
    const rpc = fakeChain(10n, {});
    const { service } = await reader(rpc, [RecordingController]);

    await service.listen();

    expect(rpc.getBlocks).not.toHaveBeenCalled();
    expect(service.getLastProcessedSlot()).toEqual(-1n);
  });

  it("reads nothing and keeps the cursor when the head is behind it", async function () {
    const rpc = fakeChain(10n, {});
    const { service } = await reader(rpc, [RecordingController], 11n);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    await service.listen();

    expect(rpc.getBlocks).not.toHaveBeenCalled();
    expect(service.getLastProcessedSlot()).toEqual(-1n);
  });

  it("reads at most chunkSize slots per run and continues after them on the next run", async function () {
    const rpc = fakeChain(10n, {
      3: [solTransfer("s1", PAYER, [MERCHANT], 1n)],
      8: [solTransfer("s2", PAYER, [MERCHANT], 2n)],
    });
    const { service, received } = await reader(rpc, [RecordingController], 1n, 5);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    await service.listen();
    await service.listen();

    expect(rpc.getBlocks.mock.calls.map(call => call.slice(0, 2))).toEqual([
      [1n, 5n],
      [6n, 10n],
    ]);
    expect(received.log).toEqual([
      `s1 ${PAYER} -1`,
      `s1 ${MERCHANT} 1`,
      "block 5",
      `s2 ${PAYER} -2`,
      `s2 ${MERCHANT} 2`,
      "block 10",
    ]);
  });

  it("logs a failing handler and still runs the other handlers and moves the cursor", async function () {
    const rpc = fakeChain(10n, { 5: [solTransfer("s1", PAYER, [MERCHANT], 1000n)] });
    const { service, received, error } = await reader(rpc, [FailingController, TypedController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    await service.listen();

    expect(received.log).toEqual([`MERCHANT s1 ${PAYER}`, `MERCHANT s1 ${MERCHANT}`]);
    expect(error).toHaveBeenCalledWith(new Error("handler failed"), expect.any(String));
    expect(service.getLastProcessedSlot()).toEqual(10n);
  });

  it("keeps the cursor when the node fails, and reads the same range on the next run", async function () {
    const rpc = fakeChain(10n, { 5: [solTransfer("s1", PAYER, [MERCHANT], 1000n)] });
    rpc.getBlock.mockImplementationOnce(() => ({ send: () => Promise.reject(new Error("node down")) }));
    const { service, received } = await reader(rpc, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT] });

    const failed = await service.listen().catch((e: Error) => e.message);
    const cursorAfterFailure = service.getLastProcessedSlot();
    await service.listen();

    expect(failed).toEqual("node down");
    expect(cursorAfterFailure).toEqual(-1n);
    expect(received.log).toEqual([`s1 ${PAYER} -1000`, `s1 ${MERCHANT} 1000`, "block 10"]);
  });
});
