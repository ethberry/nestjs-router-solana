import { NATIVE } from "../solana.constants.js";
import type { ISolanaTransaction, ITokenBalance, ITransfer } from "../interfaces/index.js";

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// Every balance change of one transaction: native SOL per account, SPL tokens per (owner, mint).
// Amounts come from the balances before and after the transaction, never from its instructions: a Token-2022 transfer
// fee, several transfers in one transaction or an extra account (a Solana Pay reference) make the instructions lie.
// The fee is not a transfer: it is added back to the fee payer (account 0). So a failed transaction, whose only
// balance change is the fee, gives no transfers.
export function getTransfers(tx: ISolanaTransaction): Array<Omit<ITransfer, "slot" | "signature">> {
  const { meta, transaction } = tx;
  if (!meta) {
    return [];
  }

  const keys = transaction.message.accountKeys.map(key => key.pubkey);
  const memo = transaction.message.instructions.flatMap(instruction =>
    instruction.programId === MEMO_PROGRAM && "parsed" in instruction ? [String(instruction.parsed)] : [],
  );

  const transfers: Array<Omit<ITransfer, "slot" | "signature">> = [];

  keys.forEach((owner, index) => {
    const fee = index === 0 ? BigInt(meta.fee) : 0n;
    const amount = BigInt(meta.postBalances[index]) - BigInt(meta.preBalances[index]) + fee;
    if (amount !== 0n) {
      transfers.push({ owner, asset: NATIVE, amount, memo });
    }
  });

  // a token account created in this transaction has no "pre" entry; one closed in it has no "post" entry
  const tokens = new Map<string, { owner: string; asset: string; amount: bigint }>();
  const add = (balances: readonly ITokenBalance[] | undefined, sign: bigint) => {
    for (const balance of balances ?? []) {
      if (!balance.owner) {
        continue;
      }
      const key = `${balance.owner} ${balance.mint}`;
      const entry = tokens.get(key) ?? { owner: balance.owner, asset: balance.mint, amount: 0n };
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
