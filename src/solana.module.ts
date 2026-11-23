import { Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";

import { solanaRpcProvider } from "./providers/rpc.js";
import { SolanaService } from "./solana.service.js";
import { ConfigurableModuleClass } from "./solana.module-definition.js";

@Module({
  imports: [ConfigModule, DiscoveryModule, ScheduleModule.forRoot()],
  providers: [solanaRpcProvider, Logger, SolanaService],
  exports: [SolanaService],
})
export class SolanaModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly solanaService: SolanaService) {
    super();
  }

  public onModuleInit(): void {
    return this.solanaService.init();
  }

  public onModuleDestroy(): void {
    return this.solanaService.destroy();
  }
}
