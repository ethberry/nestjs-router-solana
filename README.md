# @ethberry/nestjs-solana

Reads Solana block by block and hands the transfers of watched addresses to Nest controllers.

## Peers

`@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/microservices`, `@nestjs/schedule`, `@solana/kit`, `rxjs`.

## Configuration

- `SOLANA_RPC_URL`: the JSON-RPC endpoint (default `http://localhost:8899`).
- Module options (`ISolanaModuleOptions`): `fromSlot` (where to start), `commitment` (`finalized` by default), `chunkSize` (slots per run), `cron`, `debug`.

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
  public transfer(@Payload() event: ILogEvent<ITransfer>) {
    // event.args: { slot, signature, owner, asset ("native" or the mint), amount (signed), memo }
  }

  // after every processed range: save the cursor
  @EventPattern({ eventName: BLOCK_EVENT })
  public block(@Payload() event: ILogEvent<IBlockEvent>) {
    return this.settings.update("SOLANA_SLOT", event.args.slot.toString());
  }
}
```

## Writing handlers

- A watched address (a wallet, or a Solana Pay reference) makes the reader hand over **every** balance change of each transaction that names it: one `Transfer` per change (the payer's minus, the receiver's plus, the rent of a token account created on the way). For a payment to a merchant, keep `owner === merchant` and the expected `asset`; the same transaction comes as several events, so dedupe by `signature`.
- A token payment names the merchant's token account, not always the merchant's wallet; the reader still routes it, because it also matches the owner of a changed token balance.
- The reference of a payment: the second handler argument is the transaction as `getBlock` returned it; its keys are `transaction.message.accountKeys[].pubkey`. Register the merchants' wallets (few, stable), not one reference per payment.
- A failed transaction (`meta.err` set) never gives a `Transfer`: its only balance change is the fee, which is not reported.
- Amounts are signed base units (lamports, or token units of the mint's decimals). The fee payer's native amount excludes the fee.
- Save the cursor in the `block` handler: it runs after every handler of the range.

How it works: [docs/block-reader.md](docs/block-reader.md).
