import { NATIVE } from "../solana.constants.js";
import type { ISolanaTransaction } from "../interfaces/index.js";
import { getTransfers } from "./get-transfers.js";

const PAYER = "Payer111111111111111111111111111111111111111";
const MERCHANT = "Merchant11111111111111111111111111111111111";
const MERCHANT_ATA = "MerchantAta1111111111111111111111111111111111";
const PAYER_ATA = "PayerAta111111111111111111111111111111111111";
const MINT = "Mint1111111111111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const FEE = 5000n;

// a transaction as getBlock(…, { encoding: "jsonParsed" }) returns it, with only the fields the reader uses
const tx = (
  meta: Partial<NonNullable<ISolanaTransaction["meta"]>>,
  keys: string[],
  memo?: string,
): ISolanaTransaction => ({
  transaction: {
    signatures: ["sig"],
    message: {
      accountKeys: keys.map(pubkey => ({ pubkey })),
      instructions: memo ? [{ programId: MEMO_PROGRAM, parsed: memo }] : [],
    },
  },
  meta: { err: null, fee: FEE, preBalances: [], postBalances: [], ...meta },
});

describe("getTransfers", function () {
  it("reports a native transfer by balances, without the fee, with the memo", function () {
    const transaction = tx(
      { preBalances: [10_000_000n, 0n], postBalances: [10_000_000n - 1_000_000n - FEE, 1_000_000n] },
      [PAYER, MERCHANT],
      "order:1",
    );

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([
      { owner: PAYER, asset: NATIVE, amount: -1_000_000n, memo: ["order:1"] },
      { owner: MERCHANT, asset: NATIVE, amount: 1_000_000n, memo: ["order:1"] },
    ]);
  });

  it("reports nothing for a transaction that only paid the fee", function () {
    const transaction = tx({ preBalances: [10_000_000n], postBalances: [10_000_000n - FEE] }, [PAYER]);

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([]);
  });

  it("reports nothing for a failed transaction", function () {
    const transaction = tx(
      {
        err: { InstructionError: [0, "Custom"] },
        preBalances: [10_000_000n, 0n],
        postBalances: [10_000_000n - FEE, 0n],
      },
      [PAYER, MERCHANT],
    );

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([]);
  });

  it("reports a token transfer by owner, also into a token account created in the same transaction", function () {
    const transaction = tx(
      {
        preBalances: [10_000_000n, 0n, 0n],
        postBalances: [10_000_000n - FEE, 0n, 0n],
        // the merchant's token account did not exist before: no "pre" entry
        preTokenBalances: [{ mint: MINT, owner: PAYER, uiTokenAmount: { amount: "9000" } }],
        postTokenBalances: [
          { mint: MINT, owner: PAYER, uiTokenAmount: { amount: "4000" } },
          { mint: MINT, owner: MERCHANT, uiTokenAmount: { amount: "5000" } },
        ],
      },
      [PAYER, PAYER_ATA, MERCHANT_ATA],
    );

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([
      { owner: PAYER, asset: MINT, amount: -5000n, memo: [] },
      { owner: MERCHANT, asset: MINT, amount: 5000n, memo: [] },
    ]);
  });
});
