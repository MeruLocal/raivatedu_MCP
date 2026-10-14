/** Shared dependencies passed to every tool/resource/prompt registrar. */

import type { RuntimeConfig } from "./config.js";
import type { WebsiteClient } from "./services/website-client.js";
import type { Logger } from "./utils/logger.js";

export interface ServerContext {
  config: RuntimeConfig;
  client: WebsiteClient;
  logger: Logger;
}
