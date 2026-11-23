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
  // (from, to): the range asked for
  const getBlocks = jest.fn((_from: bigint, _to: bigint) => ({ send: () => Promise.resolve([] as bigint[]) }));
  const rpc = {
    getSlot: () => ({ send: () => Promise.resolve(HEAD) }),
    getFirstAvailableBlock: () => ({ send: () => Promise.resolve(FIRST_AVAILABLE) }),
    getBlocks,
  };

  afterEach(function () {
    getBlocks.mockClear();
  });

  it("reports the slots it can no longer read and continues from the first available one", async function () {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        SolanaModule.register({ fromSlot: CURSOR, debug: false, cron: CronExpression.EVERY_HOUR }),
      ],
    })
      .overrideProvider(SOLANA_RPC)
      .useValue(rpc)
      .compile();
    const error = jest.spyOn(module.get(Logger), "error").mockImplementation(() => undefined);
    const service = module.get(SolanaService);
    service.updateRegistry({
      contractType: "WATCHED",
      contractAddress: ["Watched111111111111111111111111111111111111"],
    });

    await service.listen();

    expect(error).toHaveBeenCalledWith(
      `Slots ${CURSOR}..${FIRST_AVAILABLE - 1n} are no longer on the node; their transfers are not read`,
      expect.any(String),
    );
    expect(getBlocks.mock.calls[0].slice(0, 2)).toEqual([FIRST_AVAILABLE, HEAD]);
    expect(service.getLastProcessedSlot()).toEqual(HEAD);
  });
});
