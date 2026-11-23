// Against the local Solana node (docker-compose.yml, service `solana`; SOLANA_RPC_URL, default http://localhost:8899).
import { Controller, Injectable } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression } from "@nestjs/schedule";
import { generateKeyPairSigner } from "@solana/kit";

import { BLOCK_EVENT, NATIVE, SolanaEventType } from "./solana.constants.js";
import type { IBlockEvent, ILogEvent, ITransfer } from "./interfaces/index.js";
import { SolanaModule } from "./solana.module.js";
import { SolanaService } from "./solana.service.js";
import {
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

describe("SolanaService on the local node", function () {
  let module: TestingModule;
  let received: Received;
  let service: SolanaService;

  beforeEach(async function () {
    const fromSlot = await rpc.getSlot({ commitment: "confirmed" }).send();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        SolanaModule.register({ fromSlot, commitment: "confirmed", debug: true, cron: CronExpression.EVERY_SECOND }),
      ],
      providers: [Received],
      controllers: [TestController],
    }).compile();
    received = module.get(Received);
    service = module.get(SolanaService);
    await module.init();
  });

  afterEach(async function () {
    await module.close();
  });

  it("routes the transfers of every transaction that names a watched address", async function () {
    const [payer, merchant, reference, fresh] = await Promise.all([
      fundedPayer(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [merchant.address] });
    service.updateRegistry({ contractType: ContractType.ORDER, contractAddress: [reference.address] });
    service.updateRegistry({ contractType: ContractType.FRESH, contractAddress: [fresh.address] });

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
});
