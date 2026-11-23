// The local Solana node of the tests (docker-compose.yml, service `solana`) and the steps that make transfers on it.
import {
  AccountRole,
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { Address, Instruction, KeyPairSigner } from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
// the validator serves PubSub on the RPC port + 1
const wsUrl = new URL(RPC_URL);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.port = String(Number(wsUrl.port) + 1);

export const SOL = 1_000_000_000n;
export const DECIMALS = 6;
const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl.href);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const airdrop = airdropFactory({ rpc, rpcSubscriptions });

// Sends one transaction at "confirmed"; returns its slot. A failing one is sent without preflight, so it lands in a
// block with an error, and its slot is still returned.
export async function send(payer: KeyPairSigner, instructions: Instruction[], fails = false): Promise<bigint> {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(tx);
  await sendAndConfirm(tx, { commitment: "confirmed", skipPreflight: fails }).catch((e: unknown) => {
    if (!fails) {
      throw e;
    }
  });
  const status = await rpc
    .getTransaction(getSignatureFromTransaction(tx), {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  return status!.slot;
}

export async function fundedPayer(): Promise<KeyPairSigner> {
  const payer = await generateKeyPairSigner();
  await airdrop({ recipientAddress: payer.address, lamports: lamports(10n * SOL), commitment: "confirmed" });
  return payer;
}

export function memo(text: string): Instruction {
  return { programAddress: MEMO_PROGRAM, data: new TextEncoder().encode(text) };
}

// a Solana Pay reference: an extra read-only account the programs ignore; it only makes the transaction name it
export function withReference(instruction: Instruction, reference: Address): Instruction {
  return {
    ...instruction,
    accounts: [...(instruction.accounts ?? []), { address: reference, role: AccountRole.READONLY }],
  };
}

export function transferSol(payer: KeyPairSigner, to: Address, amount: bigint): Instruction {
  return getTransferSolInstruction({ source: payer, destination: to, amount });
}

// A new mint with `amount` tokens on the payer's token account
export async function createToken(payer: KeyPairSigner, amount: bigint): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
  await send(payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: rent,
      space: getMintSize(),
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: payer.address }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: payer.address, mint: mint.address }),
    getMintToCheckedInstruction({
      mint: mint.address,
      token: await ata(payer.address, mint.address),
      mintAuthority: payer,
      amount,
      decimals: DECIMALS,
    }),
  ]);
  return mint.address;
}

// Creates the receiver's token account and transfers to it, in one transaction
export async function transferToken(
  payer: KeyPairSigner,
  mint: Address,
  to: Address,
  amount: bigint,
): Promise<Instruction[]> {
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: to, mint }),
    getTransferCheckedInstruction({
      source: await ata(payer.address, mint),
      mint,
      destination: await ata(to, mint),
      authority: payer,
      amount,
      decimals: DECIMALS,
    }),
  ];
}

async function ata(owner: Address, mint: Address): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return account;
}

// Waits until `done` holds, checking every 200 ms
export async function waitFor(done: () => boolean): Promise<void> {
  while (!done()) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
