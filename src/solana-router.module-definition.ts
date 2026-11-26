import { ConfigurableModuleBuilder } from "@nestjs/common";

import { ISolanaRouterModuleOptions } from "./interfaces/index.js";

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ISolanaRouterModuleOptions>().build();
