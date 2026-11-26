# Block reader

`SolanaService` reads Solana slot by slot and turns every transaction that names a watched address into `Transfer` events for Nest controllers (`@EventPattern({ contractType, eventName: "Transfer" })`). It is the Solana counterpart of `@ethberry/nestjs-router-eth`: the same module shape, registry and patterns.

## Configuration

- `SOLANA_RPC_URL` (env, through `ConfigService`): the JSON-RPC endpoint the `SOLANA_RPC` provider (`createSolanaRpc` of `@solana/kit`) uses.
- Module options (`ISolanaModuleOptions`, `SolanaModule.register` / `registerAsync`):
  - `fromSlot`: the first slot to read; the app passes its saved cursor + 1.
  - `commitment`: `finalized` by default. `confirmed` is faster, but a confirmed slot can still be rolled back; use it only where a rolled-back transfer does no harm (tests).
  - `chunkSize`: slots per run (one `getBlocks` call), default 100 (about 40 s of chain). It is also the most a failed run reads again.
  - `cron`: how often a run starts. `debug` is accepted for parity with nestjs-router-eth.

## Cycle (`listen`)

`init()` (from `SolanaModule.onModuleInit`) registers a cron job (`solanaListener_<id>` in `SchedulerRegistry`). A tick starts `listen()`.

- After a failed run (a node error, the history check) the next ticks are skipped, doubling: 1, 3, 7, up to 15 ticks, so after a node outage the reader tries again within 16 ticks. A tick that finds a run the app started itself still going does nothing and does not touch the count. A failing handler does not fail the run. Every failure is logged as an error with its count (`Run failed N time(s) in a row, next try in M tick(s): …`). A successful run resets the count.
- `listen()` runs one range at a time: a call while a run is going (a cron tick, or the app calling it) returns at once.

1. Nothing happens while the registry is empty.
2. The head is `getSlot` at `commitment`. Nothing happens while `fromSlot` is above it.
3. The range is `fromSlot .. min(head, fromSlot + chunkSize − 1)`. `getBlocks(from, to)` lists the slots that have a block (a leader may skip its slot).
4. History check: a node that keeps only recent blocks (`getFirstAvailableBlock`) answers `getBlocks` below its first block from that first block, silently. When `fromSlot` is older and `getBlocks` returned nothing below the first block, the run **throws** (`Slots a..b are no longer on the node: reading stops here…`) and keeps throwing: read them from a node with full history, or move the cursor on purpose. A node with full history (a BigTable-backed provider) returns the older slots, and reading goes on.
5. Each listed slot is read with `getBlock(slot, { encoding: "jsonParsed", transactionDetails: "full", maxSupportedTransactionVersion: 0, rewards: false })`. A listed slot whose block the node does not return (`null`) is an error, not an empty block: skipping it would lose its transfers.
6. The **whole range is read before any handler runs**. An RPC error in the middle of a range (a 429 of a public node, a timeout) therefore delivers nothing; the next run reads the range again.
7. The events of the range go to the handlers **one at a time, in chain order** (slot, then position in the block).
8. Passes: a handler may register a new address (`updateRegistry`) while the range is handled. After all events of a pass, the range is read again for the addresses that appeared during it, until none appears. The new address gets its transfers of the whole range, earlier slots included. A transaction goes to a contract type at most once per range, also when a later pass adds another of its addresses to that type.
9. A handler that throws (also synchronously) or rejects is **logged and skipped**: the other handlers of that event and the later events still run, and the event is not delivered again.
10. Then the `block` event (`{ eventName: "block" }`, args `{ slot: to }`) goes to its handlers, if there are any, after every transfer handler of the range has finished. A failing block handler is logged like any other.
11. The cursor moves: `fromSlot` becomes `to + 1`, `getLastProcessedSlot()` returns `to` (−1 before the first range).

### Delivery guarantee

Each event is delivered once. The reader never moves past a range it could not read (a node error ends the run before any handler; the next run reads the range again), but it does not hold the cursor for a handler: a handler that fails is logged and its event is not delivered again. What to do with an event it could not handle (retry inside, an outbox, a dead-letter record) is the handler's business; `signature` identifies the transaction.

An event can still come twice after a restart before the app saved the cursor (the range since the last save is read again), so a handler that records payments keeps them unique by `signature`.

### Shutdown

`destroy()` (from `SolanaModule.onModuleDestroy`) stops and removes the cron job. A run in progress stops before its next handler and does not move the cursor.

## Transfers (`getTransfers`)

Solana's token, system and memo programs emit no events, so transfers come from the balances before and after a transaction, never from its instructions (a Token-2022 transfer fee, several transfers in one transaction, or an extra account such as a Solana Pay reference make `jsonParsed` instructions misleading: a reference on `transferChecked` is shown as a multisig signer).

- A transaction with `meta.err` (failed) gives nothing: its only real change is the fee. `err` is `null` on success; an RPC that leaves it out is read as success.
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
- `src/solana.routing.spec.ts` (a fake chain: the RPC stubbed with blocks built in the test): delivery and its args, unwatched and wrong-case addresses, one delivery per contract type, several contract types, registry merge, an address registered by a handler mid-range (whole range, once, no repeat when its type grows), the block event after the handlers with the range's last slot, the cursor without a block handler, an empty registry, a head behind the cursor, `chunkSize`, a handler that rejects or throws (logged; the event's other handlers and later events run, the cursor moves, nothing comes again), a failing block handler (logged, the cursor moves), a node error mid-range (nothing delivered, the whole range next time), a missing block, a second `listen()` during a run, the growing pause after failed runs (a node that is down), `destroy` during a run.
- `src/solana.history.spec.ts` (stubbed RPC): a cursor older than a pruned node's first block stops the reader and keeps the cursor; a node that serves the older slots is read on.
- `src/utils/get-transfers.spec.ts`: the balance arithmetic, fee, failed transaction, `err` left out by the RPC, decimals, new and closed token accounts, Memo v1 and inner-instruction memos.
