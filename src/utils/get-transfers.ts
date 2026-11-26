import { NATIVE } from "../solana-router.constants.js";
import type { ISolanaTransaction, ITokenBalance, ITransfer } from "../interfaces/index.js";

// the SPL Memo program, its current version and the first one
const MEMO_PROGRAMS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
const SOL_DECIMALS = 9;

// Every balance change of one successful transaction: native SOL per account, SPL tokens per (owner, mint).
// Amounts come from the balances before and after the transaction, never from its instructions: a Token-2022 transfer
// fee, several transfers in one transaction or an extra account (a Solana Pay reference) make the instructions lie.
// The fee is not a transfer: it is added back to the fee payer (account 0). A failed transaction moved nothing.
export function getTransfers(tx: ISolanaTransaction): Array<Omit<ITransfer, "slot" | "signature">> {
  const { meta, transaction } = tx;
  // `err` is null for a successful transaction; an RPC may leave it out, which is not a failure
  const failed = meta?.err !== null && meta?.err !== undefined;
  if (!meta || failed) {
    return [];
  }

  const keys = transaction.message.accountKeys.map(key => key.pubkey);
  // memos of the transaction's own instructions and of instructions called by programs (CPI), in order
  const instructions = [
    ...transaction.message.instructions,
    ...(meta.innerInstructions ?? []).flatMap(inner => inner.instructions),
  ];
  const memo = instructions.flatMap(instruction =>
    MEMO_PROGRAMS.includes(instruction.programId) && "parsed" in instruction ? [String(instruction.parsed)] : [],
  );

  const transfers: Array<Omit<ITransfer, "slot" | "signature">> = [];

  keys.forEach((owner, index) => {
    const fee = index === 0 ? BigInt(meta.fee) : 0n;
    const amount = BigInt(meta.postBalances[index]) - BigInt(meta.preBalances[index]) + fee;
    if (amount !== 0n) {
      transfers.push({ owner, asset: NATIVE, amount, decimals: SOL_DECIMALS, memo });
    }
  });

  // a token account created in this transaction has no "pre" entry; one closed in it has no "post" entry
  const tokens = new Map<string, Omit<ITransfer, "slot" | "signature" | "memo">>();
  const add = (balances: readonly ITokenBalance[] | undefined, sign: bigint) => {
    for (const balance of balances ?? []) {
      if (!balance.owner) {
        continue;
      }
      const key = `${balance.owner} ${balance.mint}`;
      const entry = tokens.get(key) ?? {
        owner: balance.owner,
        asset: balance.mint,
        amount: 0n,
        decimals: balance.uiTokenAmount.decimals,
      };
      entry.amount += sign * BigInt(balance.uiTokenAmount.amount);
      tokens.set(key, entry);
    }
  };
  add(meta.preTokenBalances, -1n);
  add(meta.postTokenBalances, 1n);
  for (const entry of tokens.values()) {
    if (entry.amount !== 0n) {
      transfers.push({ ...entry, memo });
    }
  }

  return transfers;
}
