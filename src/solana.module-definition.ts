import { ConfigurableModuleBuilder } from "@nestjs/common";

import { ISolanaModuleOptions } from "./interfaces/index.js";

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ISolanaModuleOptions>().build();
