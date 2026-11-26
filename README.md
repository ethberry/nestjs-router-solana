# @ethberry/nestjs-router-solana

Reads Solana slot by slot and hands the transfers of watched addresses to Nest controllers, the way `@ethberry/nestjs-router-eth` hands EVM logs.

## Peers

`@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/microservices`, `@nestjs/schedule`, `cron`, `@solana/kit`, `rxjs`.

## Exports

- `SolanaModule` (`register` / `registerAsync` with `ISolanaModuleOptions`), `SolanaService`.
- `SolanaService`: `updateRegistry({ contractType, contractAddress })`, `getRegistry()`, `getLastProcessedSlot()`, `listen()` (one run; the cron calls it).
- `SolanaEventType.TRANSFER`, `BLOCK_EVENT`, `NATIVE`, `SOLANA_RPC` (the RPC provider token), `getTransfers(tx)`.
- Types: `ITransfer`, `IBlockEvent`, `ILogEvent`, `IContractOptions`, `ISolanaTransaction`, `ISolanaModuleOptions`.

## Configuration

- `SOLANA_RPC_URL`: the JSON-RPC endpoint.
- Module options (`ISolanaModuleOptions`): `fromSlot` (where to start), `commitment` (`finalized` by default), `chunkSize` (slots per run, default 100; also the most a failed run reads again), `cron`, `debug`. After a failed run the next cron ticks are skipped, doubling up to 15.

## Example

```ts
@Module({
  imports: [
    SolanaModule.registerAsync({
      imports: [ConfigModule, SettingsModule],
      inject: [SettingsService],
      useFactory: async (settings: SettingsService) => ({
        fromSlot: BigInt(await settings.retrieveByKey("SOLANA_SLOT")) + 1n,
        cron: CronExpression.EVERY_10_SECONDS,
        debug: false,
      }),
    }),
  ],
  controllers: [PaymentController],
})
export class PaymentModule {}

@Controller()
export class PaymentController {
  constructor(private readonly solanaService: SolanaService, private readonly settings: SettingsService) {}

  public onModuleInit() {
    this.solanaService.updateRegistry({ contractType: "MERCHANT", contractAddress: [merchantWallet] });
  }

  @EventPattern({ contractType: "MERCHANT", eventName: SolanaEventType.TRANSFER })
  public transfer(@Payload() event: ILogEvent<ITransfer>, @Ctx() tx: ISolanaTransaction) {
    // event.args: { slot, signature, owner, asset ("native" or the mint), amount (signed), decimals, memo }
  }

  // after every handler of the range has finished: save the cursor
  @EventPattern({ eventName: BLOCK_EVENT })
  public block(@Payload() event: ILogEvent<IBlockEvent>) {
    return this.settings.update("SOLANA_SLOT", event.args.slot.toString());
  }
}
```

## Writing handlers

- **Each event once.** A handler that throws or rejects is logged and skipped; its event is not delivered again. Handle your own failures (retry inside the handler, an outbox). After a restart before the cursor was saved, the range since the last save comes again: record a payment once per `signature`.
- A watched address (a wallet, or a Solana Pay reference) makes the reader hand over **every** balance change of each transaction that names it: one `Transfer` per change (the payer's minus, the receiver's plus, the rent of a token account created on the way). For a payment to a merchant, keep `owner === merchant` and the expected `asset`; the same transaction comes as several events.
- A token payment names the merchant's token account, not always the merchant's wallet; the reader still routes it, because it also matches the owner of a changed token balance.
- The reference of a payment: the second handler argument is the transaction as `getBlock` returned it; its keys are `transaction.message.accountKeys[].pubkey`. Register the merchants' wallets (few, stable), not one reference per payment.
- A failed transaction (`meta.err` set) never gives a `Transfer`; a transaction whose RPC left `err` out counts as successful.
- Amounts are signed base units; `decimals` is 9 for SOL and the mint's for a token. The fee payer's native amount excludes the fee.
- Save the cursor in the `block` handler: it runs after every transfer handler of the range has finished.
- When the cursor is older than the node's history, the reader stops with an error instead of skipping slots.

How it works, in full: [docs/block-reader.md](docs/block-reader.md).
