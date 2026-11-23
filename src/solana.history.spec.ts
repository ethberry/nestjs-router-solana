// A cursor older than the node's history: the node keeps only recent blocks, and getBlocks from an older slot silently
// starts at the first one it has. The RPC is stubbed: a local validator's history starts at its own first slot.
import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { CronExpression } from "@nestjs/schedule";

import { SOLANA_RPC } from "./solana.constants.js";
import { SolanaModule } from "./solana.module.js";
import { SolanaService } from "./solana.service.js";

const HEAD = 100n;
const FIRST_AVAILABLE = 50n;
const CURSOR = 10n;

describe("SolanaService with pruned history", function () {
  const getBlocks = jest.fn(() => ({ send: () => Promise.resolve([] as bigint[]) }));
  const rpc = {
    getSlot: () => ({ send: () => Promise.resolve(HEAD) }),
    getFirstAvailableBlock: () => ({ send: () => Promise.resolve(FIRST_AVAILABLE) }),
    getBlocks,
  };

  afterEach(function () {
    getBlocks.mockClear();
  });

  it("stops at slots the node no longer has instead of skipping them, and keeps the cursor", async function () {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        SolanaModule.register({ fromSlot: CURSOR, debug: false, cron: CronExpression.EVERY_HOUR }),
      ],
    })
      .overrideProvider(SOLANA_RPC)
      .useValue(rpc)
      .compile();
    jest.spyOn(module.get(Logger), "log").mockImplementation(() => undefined);
    const service = module.get(SolanaService);
    service.updateRegistry({
      contractType: "WATCHED",
      contractAddress: ["Watched111111111111111111111111111111111111"],
    });

    const failed = await service.listen().catch((e: Error) => e.message);

    expect(failed).toEqual(
      `Slots ${CURSOR}..${FIRST_AVAILABLE - 1n} are no longer on the node: reading stops here. Read them from a node ` +
        `with full history, or move the cursor (fromSlot) on purpose.`,
    );
    expect(getBlocks).not.toHaveBeenCalled();
    expect(service.getLastProcessedSlot()).toEqual(-1n);
  });
});
