// Against the local Solana node of docker-compose.yml (SOLANA_RPC_URL, default http://localhost:8999).
import { Controller, Injectable } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression } from "@nestjs/schedule";
import { generateKeyPairSigner } from "@solana/kit";

import { BLOCK_EVENT, NATIVE, SolanaEventType } from "./solana-router.constants.js";
import type { IBlockEvent, ILogEvent, ITransfer } from "./interfaces/index.js";
import { SolanaRouterModule } from "./solana-router.module.js";
import { SolanaRouterService } from "./solana-router.service.js";
import {
  RPC_URL,
  SOL,
  createToken,
  fundedPayer,
  memo,
  rpc,
  send,
  transferSol,
  transferToken,
  waitFor,
  withReference,
} from "./test-utils.js";

enum ContractType {
  MERCHANT = "MERCHANT",
  ORDER = "ORDER",
  FRESH = "FRESH",
}

@Injectable()
class Received {
  public transfers: Record<ContractType, ITransfer[]> = { MERCHANT: [], ORDER: [], FRESH: [] };
  public lastSlot = -1n;
}

@Controller()
class TestController {
  constructor(private readonly received: Received) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: SolanaEventType.TRANSFER })
  public merchant(@Payload() event: ILogEvent<ITransfer>): void {
    this.received.transfers.MERCHANT.push(event.args);
  }

  @EventPattern({ contractType: ContractType.ORDER, eventName: SolanaEventType.TRANSFER })
  public order(@Payload() event: ILogEvent<ITransfer>): void {
    this.received.transfers.ORDER.push(event.args);
  }

  @EventPattern({ contractType: ContractType.FRESH, eventName: SolanaEventType.TRANSFER })
  public fresh(@Payload() event: ILogEvent<ITransfer>): void {
    this.received.transfers.FRESH.push(event.args);
  }

  @EventPattern({ eventName: BLOCK_EVENT })
  public block(@Payload() event: ILogEvent<IBlockEvent>): void {
    this.received.lastSlot = event.args.slot;
  }
}

// A started reader from `fromSlot` (at "confirmed", to keep the test short), watching the given addresses
// at "confirmed" to keep the tests short; `defaultCommitment`: no commitment option, the module's default (finalized)
async function startReader(
  fromSlot: bigint,
  watch: Partial<Record<ContractType, string[]>>,
  defaultCommitment = false,
) {
  const options = { fromSlot, debug: true, cron: CronExpression.EVERY_SECOND };
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ SOLANA_RPC_URL: RPC_URL })] }),
      SolanaRouterModule.register(defaultCommitment ? options : { ...options, commitment: "confirmed" }),
    ],
    providers: [Received],
    controllers: [TestController],
  }).compile();
  const service = module.get(SolanaRouterService);
  for (const [contractType, contractAddress] of Object.entries(watch)) {
    service.updateRegistry({ contractType, contractAddress });
  }
  await module.init();
  return { module, received: module.get(Received) };
}

const currentSlot = () => rpc.getSlot({ commitment: "confirmed" }).send();

describe("SolanaRouterService on the local node", function () {
  let module: TestingModule | undefined;

  afterEach(async function () {
    await module?.close();
    module = undefined;
  });

  it("routes the transfers of every transaction that names a watched address", async function () {
    const [payer, merchant, reference, fresh] = await Promise.all([
      fundedPayer(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const reader = await startReader(await currentSlot(), {
      MERCHANT: [merchant.address],
      ORDER: [reference.address],
      FRESH: [fresh.address],
    });
    module = reader.module;
    const { received } = reader;

    // 1 SOL with a memo to the merchant: payer -1 SOL, merchant +1 SOL
    await send(payer, [transferSol(payer, merchant.address, SOL), memo("order:1")]);
    // 1000 lamports to a fresh address: below the rent-exempt minimum, the transaction fails and moves nothing
    await send(payer, [transferSol(payer, fresh.address, 1000n)], true);
    // tokens to the merchant with a reference, its token account created in the same transaction:
    // payer -rent and the new token account +rent (native), payer -5 and merchant +5 (token)
    const mint = await createToken(payer, 10_000_000n);
    const [createAta, transfer] = await transferToken(payer, mint, merchant.address, 5_000_000n);
    const lastSlot = await send(payer, [createAta, withReference(transfer, reference.address)]);

    await waitFor(() => received.lastSlot >= lastSlot);

    const { MERCHANT, ORDER, FRESH } = received.transfers;
    expect(MERCHANT).toHaveLength(6);
    expect(MERCHANT.filter(t => t.owner === merchant.address)).toEqual([
      expect.objectContaining({ asset: NATIVE, amount: SOL, memo: ["order:1"] }),
      expect.objectContaining({ asset: mint, amount: 5_000_000n, memo: [] }),
    ]);
    expect(ORDER).toHaveLength(4);
    expect(ORDER.filter(t => t.owner === merchant.address)).toEqual([
      expect.objectContaining({ asset: mint, amount: 5_000_000n }),
    ]);
    expect(FRESH).toEqual([]);
  });

  it("routes a token transfer to the owner of an existing token account the transaction does not name", async function () {
    const [payer, merchant] = await Promise.all([fundedPayer(), generateKeyPairSigner()]);
    const mint = await createToken(payer, 10_000_000n);
    const [createAta, transfer] = await transferToken(payer, mint, merchant.address, 5_000_000n);
    // the merchant's token account exists before the reader starts
    const createdAt = await send(payer, [createAta]);
    const reader = await startReader(createdAt + 1n, { MERCHANT: [merchant.address] });
    module = reader.module;

    // the transfer names the merchant's token account, not the merchant
    const lastSlot = await send(payer, [transfer]);
    await waitFor(() => reader.received.lastSlot >= lastSlot);

    // the order of the changes inside one transaction is the node's
    const changes = reader.received.transfers.MERCHANT.map(t => `${t.owner} ${t.asset} ${t.amount}`).sort();
    expect(changes).toEqual([`${payer.address} ${mint} -5000000`, `${merchant.address} ${mint} 5000000`].sort());
  });

  it("by default reads at finalized: a transfer arrives once its slot is finalized", async function () {
    const [payer, merchant] = await Promise.all([fundedPayer(), generateKeyPairSigner()]);
    const reader = await startReader(await currentSlot(), { MERCHANT: [merchant.address] }, true);
    module = reader.module;

    const sentAt = await send(payer, [transferSol(payer, merchant.address, SOL), memo("finalized")]);
    await waitFor(() => reader.received.lastSlot >= sentAt);
    const finalized = await rpc.getSlot({ commitment: "finalized" }).send();

    expect(reader.received.transfers.MERCHANT.filter(t => t.owner === merchant.address).map(t => t.memo)).toEqual([
      ["finalized"],
    ]);
    // the reader never went past the finalized slot
    expect(reader.received.lastSlot <= finalized).toEqual(true);
  });

  it("resumes after a restart from the saved cursor: nothing lost, nothing read twice", async function () {
    const [payer, merchant] = await Promise.all([fundedPayer(), generateKeyPairSigner()]);
    const first = await startReader(await currentSlot(), { MERCHANT: [merchant.address] });
    module = first.module;

    const sentAt = await send(payer, [transferSol(payer, merchant.address, SOL), memo("before")]);
    // the cursor the app would save: the block event after the range with the transfer
    await waitFor(() => first.received.lastSlot >= sentAt);
    const saved = first.received.lastSlot;
    await first.module.close();
    module = undefined;

    // sent while the reader is down
    const downAt = await send(payer, [transferSol(payer, merchant.address, SOL), memo("while down")]);

    const second = await startReader(saved + 1n, { MERCHANT: [merchant.address] });
    module = second.module;
    await waitFor(() => second.received.lastSlot >= downAt);

    const memos = second.received.transfers.MERCHANT.filter(t => t.owner === merchant.address).map(t => t.memo);
    expect(memos).toEqual([["while down"]]);
  });
});
