# Block reader

`SolanaService` reads the chain slot by slot and turns every transaction that names a watched address into `Transfer` events for Nest controllers.

## Cycle

- `init()` (from `SolanaModule.onModuleInit`) starts a cron job (`cron` option). A run is skipped while the previous one is still going; an error of a run is logged and the next run starts from the same cursor.
- `listen()` does nothing until the registry has an entry.
- It reads the head slot at `commitment` (`finalized` by default, so a transfer is never reported before it can no longer be rolled back) and the range `fromSlot .. min(head, fromSlot + chunkSize − 1)`.
- `getBlocks(from, to)` lists the slots that have a block (a leader may skip its slot), then `getBlock(slot, { encoding: "jsonParsed", transactionDetails: "full", maxSupportedTransactionVersion: 0, rewards: false })` reads each.
- After the handlers of every event of the range have finished, the cursor moves: `fromSlot` becomes `to + 1`, `getLastProcessedSlot()` returns `to`, and the `block` event (`{ eventName: "block" }`, args `{ slot: to }`) goes to its handlers. The app saves the cursor there; on start it passes the saved slot + 1 as `fromSlot`. Nothing is lost on a crash: the range in work is read again.

## Pruned history

A node keeps only recent blocks (`getFirstAvailableBlock`); `getBlocks` from an older slot silently starts at the first available one. When `fromSlot` is older, the reader logs an error naming the lost slots and continues from the first available slot.

## Transfers (`getTransfers`)

A transaction has no transfer events (SPL Token, System and Memo programs emit none), so transfers come from the balances before and after it, never from its instructions:

- native SOL: `postBalances[i] − preBalances[i]` per account key; the fee is added back to the fee payer (account 0);
- tokens: `postTokenBalances − preTokenBalances` per (owner, mint); a token account created in the transaction has no `pre` entry, a closed one no `post` entry.

Each non-zero change is one `ITransfer`: `owner`, `asset` (`"native"` or the mint), signed `amount` (lamports or base units), `memo` (texts of the Memo instructions), `slot`, `signature`. A failed transaction changes only the fee, so it gives no transfers. Instructions are not used for amounts: a Token-2022 transfer fee, several transfers in one transaction, or an extra account (a Solana Pay reference) make `jsonParsed` instructions misleading (a reference on `transferChecked` is shown as a multisig signer).

## Routing

- The registry (`updateRegistry({ contractType, contractAddress })`) maps watched addresses to a contract type; entries of the same type are merged.
- A transaction goes to a contract type when one of its addresses is named in it: any account key, or the owner of a token balance it changes. Then **every** transfer of that transaction goes to the handlers of `{ contractType, eventName: "Transfer" }`, once per contract type. So a watched Solana Pay reference (a key that only appears in the account list) gets the whole payment, and a watched wallet also sees the payer's side.
- The second handler argument is the transaction as `getBlock` returned it.
- Handlers run one at a time, in chain order; a rejected handler is logged and does not stop the others.

## Account existence

An address becomes an account only with the rent-exempt minimum. A first transfer below it fails (`InsufficientFundsForRent`) and gives no transfer. A new token account's rent shows as a native transfer from the payer to the token account.

## Tests

`src/solana.service.spec.ts` runs against the node of `docker-compose.yml`: SOL with a memo, a failing transfer below rent, and a token transfer with a reference into a token account created in the same transaction, routed to a wallet, a reference and an address of the failing transfer. `src/utils/get-transfers.spec.ts` covers the balance arithmetic.
