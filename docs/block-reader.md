# Block reader

`SolanaService` reads Solana slot by slot and turns every transaction that names a watched address into `Transfer` events for Nest controllers (`@EventPattern({ contractType, eventName: "Transfer" })`). It is the Solana counterpart of `@ethberry/nestjs-viem`: the same module shape, registry and patterns.

## Configuration

- `SOLANA_RPC_URL` (env, through `ConfigService`): the JSON-RPC endpoint the `SOLANA_RPC` provider (`createSolanaRpc` of `@solana/kit`) uses.
- Module options (`ISolanaModuleOptions`, `SolanaModule.register` / `registerAsync`):
  - `fromSlot`: the first slot to read; the app passes its saved cursor + 1.
  - `commitment`: `finalized` by default. `confirmed` is faster, but a confirmed slot can still be rolled back; use it only where a rolled-back transfer does no harm (tests).
  - `chunkSize`: slots per run (one `getBlocks` call), default 1000.
  - `cron`: how often a run starts. `debug` is accepted for parity with nestjs-viem.

## Cycle (`listen`)

`init()` (from `SolanaModule.onModuleInit`) registers a cron job (`solanaListener_<id>` in `SchedulerRegistry`). A tick starts `listen()` unless the previous run is still going; an error of a run is logged and nothing else happens: the cursor stays, the next tick tries the same range.

1. Nothing happens while the registry is empty.
2. The head is `getSlot` at `commitment`. Nothing happens while `fromSlot` is above it.
3. History check: a node keeps only recent blocks (`getFirstAvailableBlock`), and `getBlocks` from an older slot silently starts at the first one it has. When `fromSlot` is older, the run **throws** (`Slots a..b are no longer on the node: reading stops here…`) and keeps throwing: the transfers there cannot be read from this node. Read them from a node with full history, or move the cursor on purpose.
4. The range is `fromSlot .. min(head, fromSlot + chunkSize − 1)`. `getBlocks(from, to)` lists the slots that have a block (a leader may skip its slot).
5. Each listed slot is read with `getBlock(slot, { encoding: "jsonParsed", transactionDetails: "full", maxSupportedTransactionVersion: 0, rewards: false })`. A listed slot whose block the node does not return (`null`) is an error, not an empty block: skipping it would lose its transfers.
6. The **whole range is read before any handler runs**. An RPC error in the middle of a range (a 429 of a public node, a timeout) therefore delivers nothing; the next run reads the range again.
7. The events of the range go to the handlers **one at a time, in chain order** (slot, then position in the block).
8. Passes: a handler may register a new address (`updateRegistry`) while the range is handled. After all events of a pass, the range is read again for the addresses that appeared during it, until none appears. The new address gets its transfers of the whole range, earlier slots included. A transaction goes to a contract type at most once per range, also when a later pass adds another of its addresses to that type.
9. If any handler failed, the run throws (`A handler failed in slots a..b: the range is read again on the next run`); the cursor stays.
10. Otherwise the `block` event (`{ eventName: "block" }`, args `{ slot: to }`) goes to its handlers, if there are any. If it fails, the run throws and the cursor stays.
11. The cursor moves: `fromSlot` becomes `to + 1`, `getLastProcessedSlot()` returns `to` (−1 before the first range).

### Delivery guarantee

At least once. A range is delivered again after a failed handler, a failed block handler, or a restart before the app saved the cursor. **Handlers must be idempotent by `signature`** (a payment recorded once per signature). Nothing is lost: the cursor never moves past a range whose handlers did not all succeed.

### Shutdown

`destroy()` (from `SolanaModule.onModuleDestroy`) stops and removes the cron job. A run in progress stops before its next handler and does not move the cursor.

## Transfers (`getTransfers`)

Solana's token, system and memo programs emit no events, so transfers come from the balances before and after a transaction, never from its instructions (a Token-2022 transfer fee, several transfers in one transaction, or an extra account such as a Solana Pay reference make `jsonParsed` instructions misleading: a reference on `transferChecked` is shown as a multisig signer).

- A transaction with `meta.err` (failed) gives nothing: its only real change is the fee.
- Native SOL: `postBalances[i] − preBalances[i]` per account key; the fee is added back to the fee payer (account 0), so the fee is never a transfer. `decimals` 9.
- Tokens: `postTokenBalances − preTokenBalances` per (owner, mint); a token account created in the transaction has no "pre" entry, one closed in it no "post" entry. `decimals` from `uiTokenAmount.decimals`.
- Each non-zero change is one `ITransfer`: `owner` (for a token: the owner of the token account), `asset` (`"native"` or the mint), signed `amount` in base units, `decimals`, `memo`, `slot`, `signature`.
- `memo`: the texts of the Memo program's instructions (v2 `MemoSq4g…` and v1 `Memo1Uhk…`), the transaction's own and those called by programs (inner instructions), in order.

## Routing

- The registry (`updateRegistry({ contractType, contractAddress })`) maps watched addresses to a contract type; a second call for the same type merges its addresses. Base58 addresses are matched exactly: another letter case is another address.
- A transaction goes to a contract type when it names one of the type's addresses: any account key (a wallet, a Solana Pay reference), or the owner of a token balance it changes (a token payment names the merchant's token account, not always the merchant's wallet).
- Then **every** transfer of that transaction goes to the handlers of `{ contractType, eventName: "Transfer" }`: the payer's minus, the receiver's plus, the rent of a token account created on the way. A handler keeps the changes it needs (`owner === merchant`, the expected `asset`).
- The second handler argument is the transaction as `getBlock` returned it (`transaction.message.accountKeys[].pubkey` holds a reference).
- A handler that throws (also synchronously) or rejects is logged; the other handlers of the event still run; the range is then retried (above). A pattern without a handler is logged (`Handler not found for: …`).

## Account existence

An address becomes an account only with the rent-exempt minimum. A first transfer below it fails (`InsufficientFundsForRent`) and gives no transfer. A new token account's rent shows as a native transfer from the payer to the token account.

## Limits

- Scale: every transaction of every block in the range is downloaded (`jsonParsed`, full). Mainnet blocks hold thousands of transactions, mostly votes; a public RPC will rate-limit a full scan. Production needs its own RPC node or a Geyser stream.
- Only transfers are reported; program events (Anchor `emit!` / `emit_cpi!`) are not read.

## Tests

- `src/solana.service.spec.ts`, against the node of `docker-compose.yml` (`nestjs-solana-node`):
  - SOL with a memo, a failing transfer below rent, and a token transfer with a reference into a token account created in the same transaction, routed to a wallet, a reference and the address of the failing transfer;
  - a token transfer into an existing token account, routed to its owner, whom the transaction does not name;
  - the default commitment: the transfer arrives, and the reader never passes the finalized slot;
  - a restart: a second reader started from the cursor of the first one's block event gets the transfer sent while it was down, and not the one already handled.
- `src/solana.routing.spec.ts` (a fake chain: the RPC stubbed with blocks built in the test): delivery and its args, unwatched and wrong-case addresses, one delivery per contract type, several contract types, registry merge, an address registered by a handler mid-range (whole range, once, no repeat when its type grows), the block event after the handlers with the range's last slot, the cursor without a block handler, an empty registry, a head behind the cursor, `chunkSize`, a handler that rejects or throws (others run, cursor stays, the range comes again), a failing block handler, a node error mid-range (nothing delivered, the whole range next time), a missing block, `destroy` during a run.
- `src/solana.history.spec.ts` (stubbed RPC): a cursor older than the node's first block stops the reader and keeps the cursor.
- `src/utils/get-transfers.spec.ts`: the balance arithmetic, fee, failed transaction, decimals, new and closed token accounts, Memo v1 and inner-instruction memos.
