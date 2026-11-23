export const SOLANA_RPC = Symbol("SOLANA_RPC");
export const BLOCK_EVENT = "block";
// the asset of a native SOL transfer (a token transfer has its mint there)
export const NATIVE = "native";

export enum SolanaEventType {
  TRANSFER = "Transfer",
}
