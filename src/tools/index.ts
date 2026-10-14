/** Registers every tool on the MCP server. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { registerWebsiteTools } from "./website.js";
import { registerPricingTools } from "./pricing.js";
import { registerCatalogTools } from "./catalog.js";
import { registerPageTools } from "./pages.js";

export function registerAllTools(server: McpServer, ctx: ServerContext): void {
  registerWebsiteTools(server, ctx);
  registerPageTools(server, ctx);
  registerPricingTools(server, ctx);
  registerCatalogTools(server, ctx);
}
