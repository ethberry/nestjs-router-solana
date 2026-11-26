import { NATIVE } from "../solana-router.constants.js";
import type { ISolanaTransaction } from "../interfaces/index.js";
import { getTransfers } from "./get-transfers.js";

const PAYER = "Payer111111111111111111111111111111111111111";
const MERCHANT = "Merchant11111111111111111111111111111111111";
const MERCHANT_ATA = "MerchantAta1111111111111111111111111111111111";
const PAYER_ATA = "PayerAta111111111111111111111111111111111111";
const MINT = "Mint1111111111111111111111111111111111111111";
const SOME_PROGRAM = "Program111111111111111111111111111111111111";
const MEMO_V2 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_V1 = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const FEE = 5000n;
const TOKEN_DECIMALS = 6;

// a transaction as getBlock(…, { encoding: "jsonParsed" }) returns it, with only the fields the reader uses
const tx = (
  meta: Partial<NonNullable<ISolanaTransaction["meta"]>>,
  keys: string[],
  instructions: NonNullable<ISolanaTransaction["transaction"]["message"]["instructions"]> = [],
): ISolanaTransaction => ({
  transaction: { signatures: ["sig"], message: { accountKeys: keys.map(pubkey => ({ pubkey })), instructions } },
  meta: { err: null, fee: FEE, preBalances: [], postBalances: [], ...meta },
});

// 1 000 000 lamports from the payer to the merchant
const solPayment = { preBalances: [10_000_000n, 0n], postBalances: [10_000_000n - 1_000_000n - FEE, 1_000_000n] };
const tokenBalance = (owner: string, amount: string) => ({
  mint: MINT,
  owner,
  uiTokenAmount: { amount, decimals: TOKEN_DECIMALS },
});

describe("getTransfers", function () {
  it("reports a native transfer by balances, without the fee, with 9 decimals and the memo", function () {
    const transaction = tx(solPayment, [PAYER, MERCHANT], [{ programId: MEMO_V2, parsed: "order:1" }]);

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([
      { owner: PAYER, asset: NATIVE, amount: -1_000_000n, decimals: 9, memo: ["order:1"] },
      { owner: MERCHANT, asset: NATIVE, amount: 1_000_000n, decimals: 9, memo: ["order:1"] },
    ]);
  });

  it("reads memos of Memo v1 and of memo instructions called by a program, in order", function () {
    const transaction = tx(
      {
        ...solPayment,
        innerInstructions: [{ instructions: [{ programId: MEMO_V2, parsed: "from a program" }] }],
      },
      [PAYER, MERCHANT],
      [
        { programId: MEMO_V1, parsed: "v1" },
        { programId: SOME_PROGRAM, parsed: "not a memo" },
      ],
    );

    const [transfer] = getTransfers(transaction);

    expect(transfer.memo).toEqual(["v1", "from a program"]);
  });

  it("reports the transfers of a transaction whose RPC left `err` out", function () {
    const transaction = tx({ err: undefined, ...solPayment }, [PAYER, MERCHANT]);

    const transfers = getTransfers(transaction);

    expect(transfers.map(t => t.amount)).toEqual([-1_000_000n, 1_000_000n]);
  });

  it("reports nothing for a transaction that only paid the fee", function () {
    const transaction = tx({ preBalances: [10_000_000n], postBalances: [10_000_000n - FEE] }, [PAYER]);

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([]);
  });

  it("reports nothing for a failed transaction, whatever its balances say", function () {
    const transaction = tx({ err: { InstructionError: [0, "Custom"] }, ...solPayment }, [PAYER, MERCHANT]);

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([]);
  });

  it("reports a token transfer by owner with the mint's decimals, also into a new token account", function () {
    const transaction = tx(
      {
        preBalances: [10_000_000n, 0n, 0n],
        postBalances: [10_000_000n - FEE, 0n, 0n],
        // the merchant's token account did not exist before: no "pre" entry
        preTokenBalances: [tokenBalance(PAYER, "9000")],
        postTokenBalances: [tokenBalance(PAYER, "4000"), tokenBalance(MERCHANT, "5000")],
      },
      [PAYER, PAYER_ATA, MERCHANT_ATA],
    );

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([
      { owner: PAYER, asset: MINT, amount: -5000n, decimals: TOKEN_DECIMALS, memo: [] },
      { owner: MERCHANT, asset: MINT, amount: 5000n, decimals: TOKEN_DECIMALS, memo: [] },
    ]);
  });

  it("reports a token account closed in the transaction (no 'post' entry) as its owner sending everything", function () {
    const transaction = tx(
      {
        preBalances: [10_000_000n, 0n],
        postBalances: [10_000_000n - FEE, 0n],
        preTokenBalances: [tokenBalance(PAYER, "3000")],
        postTokenBalances: [],
      },
      [PAYER, PAYER_ATA],
    );

    const transfers = getTransfers(transaction);

    expect(transfers).toEqual([{ owner: PAYER, asset: MINT, amount: -3000n, decimals: TOKEN_DECIMALS, memo: [] }]);
  });
});
