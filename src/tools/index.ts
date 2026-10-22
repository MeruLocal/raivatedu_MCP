/** Registers every tool on the MCP server. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { registerWebsiteTools } from "./website.js";
import { registerPricingTools } from "./pricing.js";
import { registerCatalogTools } from "./catalog.js";
import { registerPageTools } from "./pages.js";
import { registerLimitsTools } from "./limits.js";
import { usageEnabled, withUsageLogging } from "../utils/usage.js";

export function registerAllTools(server: McpServer, ctx: ServerContext): void {
  // Every tool gets timing + outcome usage records when enabled.
  const target = usageEnabled(ctx.config, ctx.transport)
    ? withUsageLogging(server, ctx.transport)
    : server;
  registerWebsiteTools(target, ctx);
  registerPageTools(target, ctx);
  registerPricingTools(target, ctx);
  registerCatalogTools(target, ctx);
  registerLimitsTools(target, ctx);
}
