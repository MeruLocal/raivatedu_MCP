#!/usr/bin/env node
/**
 * Entry point for the RaivatEdu MCP server (stdio transport).
 *
 * Usage:
 *   node dist/index.js            # run over stdio (for Claude Desktop etc.)
 *   node dist/index.js --http     # run over Streamable HTTP on PORT (default 3000)
 *   node dist/index.js --version  # print version and exit
 *   node dist/index.js --help     # print help and exit
 *
 * Transport can also be selected with env TRANSPORT=http and PORT=3000.
 * All logging goes to stderr so stdout stays a clean MCP protocol stream.
 */

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION, loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { runHttp } from "./http.js";

function printHelp(): void {
  process.stdout.write(
    `${SERVER_NAME} v${SERVER_VERSION}\n\n` +
      "A Model Context Protocol server for the public RaivatEdu website.\n\n" +
      "Usage: raivat-education-mcp [--http] [--help|--version]\n\n" +
      "Transports:\n" +
      "  (default)  stdio — for Claude Desktop and local MCP clients.\n" +
      "  --http     Streamable HTTP on http://localhost:PORT/mcp (PORT default 3000).\n\n" +
      "Configure via environment variables (see .env.example).\n",
  );
}

function resolvePort(): number {
  const raw = Number.parseInt(process.env.PORT ?? "3000", 10);
  return Number.isFinite(raw) && raw > 0 && raw < 65536 ? raw : 3000;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const config = loadConfig();

  const useHttp =
    argv.includes("--http") || process.env.TRANSPORT?.toLowerCase() === "http";
  if (useHttp) {
    await runHttp(config, resolvePort());
    return;
  }

  const { server, logger } = createServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(
    `${SERVER_NAME} v${SERVER_VERSION} running on stdio (market=${config.defaultMarket})`,
  );

  // Graceful shutdown on termination signals and transport close.
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})…`);
    try {
      await server.close();
    } catch (err) {
      logger.error("Error during shutdown", err);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  transport.onclose = () => void shutdown("transport closed");
}

main().catch((err) => {
  process.stderr.write(
    `Fatal error starting ${SERVER_NAME}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
