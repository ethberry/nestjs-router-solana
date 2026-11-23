import { CronExpression } from "@nestjs/schedule";

export interface ISolanaModuleOptions {
  // the first slot to read; the app keeps the last processed one (the block event) and passes the next one here
  fromSlot: bigint;
  // "finalized" by default: a transfer is never reported before it can no longer be rolled back
  commitment?: "confirmed" | "finalized";
  // slots per getBlocks request
  chunkSize?: number;
  debug: boolean;
  cron: CronExpression;
}

// Watched accounts: a transaction that names one of them (any account key, or the owner of a token balance it changes)
// goes to the handlers of its contractType
export interface IContractOptions {
  contractType: string;
  contractAddress: string[];
}

export interface ILogEvent<T = any> {
  name: string;
  args: T;
}

// One balance change of a transaction
export interface ITransfer {
  slot: bigint;
  signature: string;
  // the wallet whose balance changed (for a token: the owner of the token account)
  owner: string;
  // "native" for SOL, otherwise the mint
  asset: string;
  // signed: received > 0, sent < 0; lamports or base units of the token
  amount: bigint;
  // decimals of the asset: 9 for SOL, the mint's for a token
  decimals: number;
  // texts of the transaction's memo instructions (Memo v1 and v2), its own and those called by programs
  memo: string[];
}

export interface IBlockEvent {
  // the last slot whose transfers have all been handled: resume from the next one
  slot: bigint;
}

type IInstruction = { programId: string } | { programId: string; parsed: unknown };

// The part of a transaction of getBlock(…, { encoding: "jsonParsed" }) that the reader uses
export interface ISolanaTransaction {
  transaction: {
    signatures: readonly string[];
    message: {
      accountKeys: ReadonlyArray<{ pubkey: string }>;
      instructions: readonly IInstruction[];
    };
  };
  meta: {
    // null on success; some RPCs leave it out
    err?: unknown;
    fee: bigint | number;
    preBalances: ReadonlyArray<bigint | number>;
    postBalances: ReadonlyArray<bigint | number>;
    preTokenBalances?: readonly ITokenBalance[];
    postTokenBalances?: readonly ITokenBalance[];
    innerInstructions?: ReadonlyArray<{ instructions: readonly IInstruction[] }> | null;
  } | null;
}

export interface ITokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

// A controller method found by its pattern metadata (@EventPattern / @MessagePattern)
export interface IDiscoveredHandler<T> {
  meta: T;
  methodName: string;
  handler: (...args: any[]) => unknown;
  instance: object;
}
