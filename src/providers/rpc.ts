import { ConfigService } from "@nestjs/config";
import { createSolanaRpc } from "@solana/kit";
import type { Rpc, SolanaRpcApi } from "@solana/kit";

import { SOLANA_RPC } from "../solana.constants.js";

export const solanaRpcProvider = {
  provide: SOLANA_RPC,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Rpc<SolanaRpcApi> => {
    return createSolanaRpc(configService.get<string>("SOLANA_RPC_URL", "http://localhost:8899"));
  },
};
