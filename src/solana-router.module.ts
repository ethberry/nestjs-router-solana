import { Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";

import { solanaRpcProvider } from "./providers/rpc.js";
import { SolanaRouterService } from "./solana-router.service.js";
import { ConfigurableModuleClass } from "./solana-router.module-definition.js";

@Module({
  imports: [ConfigModule, DiscoveryModule, ScheduleModule.forRoot()],
  providers: [solanaRpcProvider, Logger, SolanaRouterService],
  exports: [SolanaRouterService],
})
export class SolanaRouterModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly solanaRouterService: SolanaRouterService) {
    super();
  }

  public onModuleInit(): void {
    return this.solanaRouterService.init();
  }

  public onModuleDestroy(): void {
    return this.solanaRouterService.destroy();
  }
}
