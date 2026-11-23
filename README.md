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

How it works: [docs/block-reader.md](docs/block-reader.md).
