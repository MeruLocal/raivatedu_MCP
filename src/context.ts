/** Shared dependencies passed to every tool/resource/prompt registrar. */

import type { RuntimeConfig } from "./config.js";
import type { WebsiteClient } from "./services/website-client.js";
import type { Logger } from "./utils/logger.js";

export interface ServerContext {
  config: RuntimeConfig;
  client: WebsiteClient;
  logger: Logger;
  /** Which transport serves this server (drives the usage-log default). */
  transport: "stdio" | "http";
}
