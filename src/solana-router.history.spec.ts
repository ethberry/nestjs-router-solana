// A cursor older than the node's first block: a node that keeps only recent blocks answers getBlocks below it from that
// first block, silently; a node with full history (a BigTable-backed provider) returns the older slots. The RPC is
// stubbed: a local validator's history starts at its own first slot.
import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { CronExpression } from "@nestjs/schedule";

import { SOLANA_RPC } from "./solana-router.constants.js";
import { SolanaRouterModule } from "./solana-router.module.js";
import { SolanaRouterService } from "./solana-router.service.js";

const HEAD = 100n;
const FIRST_AVAILABLE = 50n;
const CURSOR = 10n;

// the RPC of a node whose getBlocks for the range returns `slots`
async function reader(slots: bigint[]) {
  const rpc = {
    getSlot: () => ({ send: () => Promise.resolve(HEAD) }),
    getFirstAvailableBlock: () => ({ send: () => Promise.resolve(FIRST_AVAILABLE) }),
    getBlocks: () => ({ send: () => Promise.resolve(slots) }),
    getBlock: () => ({ send: () => Promise.resolve({ transactions: [] }) }),
  };
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      SolanaRouterModule.register({ fromSlot: CURSOR, debug: false, cron: CronExpression.EVERY_HOUR }),
    ],
  })
    .overrideProvider(SOLANA_RPC)
    .useValue(rpc)
    .compile();
  jest.spyOn(module.get(Logger), "log").mockImplementation(() => undefined);
  const service = module.get(SolanaRouterService);
  service.updateRegistry({ contractType: "WATCHED", contractAddress: ["Watched111111111111111111111111111111111111"] });
  return service;
}

describe("SolanaRouterService with a cursor older than the node's first block", function () {
  it("stops at slots a pruned node no longer has instead of skipping them, and keeps the cursor", async function () {
    // the node answers from its first block on
    const service = await reader([FIRST_AVAILABLE, FIRST_AVAILABLE + 1n]);

    const failed = await service.listen().catch((e: Error) => e.message);

    expect(failed).toEqual(
      `Slots ${CURSOR}..${FIRST_AVAILABLE - 1n} are no longer on the node: reading stops here. Read them from a node ` +
        `with full history, or move the cursor (fromSlot) on purpose.`,
    );
    expect(service.getLastProcessedSlot()).toEqual(-1n);
  });

  it("reads on when the node serves the older slots (full history)", async function () {
    const service = await reader([CURSOR, CURSOR + 1n, FIRST_AVAILABLE]);

    await service.listen();

    expect(service.getLastProcessedSlot()).toEqual(HEAD);
  });
});
