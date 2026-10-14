/**
 * Streamable HTTP transport for the RaivatEdu MCP server.
 *
 * Runs the server over HTTP (default port 3000) instead of stdio, so it can be
 * reached at http://localhost:3000/mcp by HTTP-capable MCP clients and the MCP
 * Inspector. Uses the stateless JSON pattern (a fresh server + transport per
 * request) which is simple to scale and avoids request-id collisions.
 *
 * Endpoints:
 *   POST /mcp                  – MCP JSON-RPC (the endpoint clients connect to)
 *   GET  /health               – liveness probe: {"status":"ok"}
 *   GET  /version              – name, version, live tool/resource/prompt counts, mcp_endpoint
 *   GET  /.well-known/mcp.json – discovery document (public base URL from PUBLIC_BASE_URL)
 *   GET  /                     – human-friendly status page
 */

import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  httpConfig,
  type RuntimeConfig,
} from "./config.js";
import { createServer } from "./server.js";
import { createLogger } from "./utils/logger.js";
import {
  getSharedWebsiteClient,
  type WebsiteClient,
} from "./services/website-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sitemapRefreshMs, startSitemapRefresh } from "./services/sitemap.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  jsonErrorHandler,
  loadHttpSecurityConfig,
  mcpGuards,
  type HttpSecurityConfig,
} from "./http-security.js";

const JSON_RPC_METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0" as const,
  error: {
    code: -32000,
    message:
      "This server is stateless — send MCP requests as HTTP POST to /mcp.",
  },
  id: null,
};

/** Public host the server is reached at when PUBLIC_BASE_URL is unset. */
export const DEFAULT_PUBLIC_BASE_URL = "https://mcp.raivatedu.com";

/**
 * The public base URL advertised in discovery, the status page and /version.
 * Reads PUBLIC_BASE_URL (http/https only, trailing slash stripped); never
 * derived from the request's Host or X-Forwarded-Host.
 */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) return DEFAULT_PUBLIC_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return DEFAULT_PUBLIC_BASE_URL;
    }
    if (u.username || u.password || u.search || u.hash) {
      return DEFAULT_PUBLIC_BASE_URL;
    }
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return DEFAULT_PUBLIC_BASE_URL;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SERVER_SUMMARY =
  "Read-only access to the public RaivatEdu website (admissions and education CRM software).";

/** Human-friendly status page served at GET /. */
export function statusPage(baseUrl: string): string {
  const endpoint = escapeHtml(`${baseUrl}/mcp`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RaivatEdu MCP Server</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    max-width:820px;margin:0 auto;padding:4rem 1.5rem;line-height:1.65;
    color:#1a1a1a;background:#fff;font-size:17px;
  }
  h1{font-size:2.3rem;line-height:1.25;font-weight:700;margin:0 0 1.6rem;letter-spacing:-.01em}
  p,ul{margin:1.1rem 0}
  a{color:#1a56db;text-decoration:underline}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
  .fine{font-size:.82rem;color:#6b7280;margin:.4rem 0 1.4rem}
  @media (prefers-color-scheme: dark){
    body{background:#0d0d0d;color:#e6e6e6}
    a{color:#7aa2ff}
    .fine{color:#9aa0aa}
  }
</style></head>
<body>
  <h1>RaivatEdu MCP Server</h1>

  <p>${SERVER_SUMMARY} Connect any MCP client to the Streamable HTTP endpoint
  <code>${endpoint}</code> (HTTP <code>POST</code>, no API key).</p>

  <p>What it can do:</p>
  <ul>
    <li>Plans and prices per market, exactly as the site publishes them</li>
    <li>Product features and solutions for schools, colleges, coaching institutes and training teams</li>
    <li>Resource articles</li>
    <li>Contact and demo links</li>
    <li>Page text, site search and a reachability check</li>
  </ul>

  <p class="fine">It holds no student, enquiry or customer data and performs no
  account actions. Never send credentials here.</p>

  <p>Health: <a href="/health">/health</a> &middot; Version: <a href="/version">/version</a>
  &middot; Discovery: <a href="/.well-known/mcp.json">/.well-known/mcp.json</a></p>
</body></html>`;
}

/**
 * Discovery document advertised at /.well-known/mcp.json. Tool names are
 * deliberately not listed: tools/list is the single source for those.
 */
export function discoveryDoc(baseUrl: string) {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description:
      "Read-only MCP server for the public RaivatEdu website (raivatedu.com): pricing per market, features, solutions, resource articles, contact details, page content and search.",
    transport: {
      type: "streamable-http",
      endpoint: `${baseUrl}/mcp`,
    },
    authentication: "none",
    readOnly: true,
    documentation: "https://www.raivatedu.com",
  };
}

export interface ServerCounts {
  tools: number;
  resources: number;
  resource_templates: number;
  prompts: number;
}

/** Count what a freshly built server registers, over the public protocol. */
export async function countRegistrations(
  config: RuntimeConfig,
  websiteClient?: WebsiteClient,
): Promise<ServerCounts> {
  const { server } = createServer(config, websiteClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: `${SERVER_NAME}-self-count`, version: SERVER_VERSION });
  await client.connect(clientSide);
  try {
    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    return {
      tools: tools.tools.length,
      resources: resources.resources.length,
      resource_templates: templates.resourceTemplates.length,
      prompts: prompts.prompts.length,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Build the Express app (no listening). `config` is the base runtime config;
 * the HTTP search cap is applied here.
 */
export function createHttpApp(
  baseConfig: RuntimeConfig,
  security: HttpSecurityConfig = loadHttpSecurityConfig(),
  baseUrl: string = publicBaseUrl(),
): Express {
  const config = httpConfig(baseConfig);
  const logger = createLogger(config);
  // One website client for the whole process: shared throttle, concurrency
  // cap and page cache across every stateless MCP request.
  const client = getSharedWebsiteClient(config, logger);
  const app = express();
  app.disable("x-powered-by");
  app.use("/mcp", ...mcpGuards(security));
  app.use(express.json({ limit: "1mb" }));

  // Liveness only.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Metadata: counts come live from a registered server, not hard-coded.
  let counts: Promise<ServerCounts> | undefined;
  app.get("/version", async (_req: Request, res: Response) => {
    counts ??= countRegistrations(config, client);
    try {
      res.json({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        ...(await counts),
        mcp_endpoint: `${baseUrl}/mcp`,
      });
    } catch {
      counts = undefined;
      res.json({ name: SERVER_NAME, version: SERVER_VERSION, mcp_endpoint: `${baseUrl}/mcp` });
    }
  });

  app.get("/.well-known/mcp.json", (_req: Request, res: Response) => {
    // Public metadata with no credentials: readable by browser inspectors.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(discoveryDoc(baseUrl));
  });

  app.get("/", (_req: Request, res: Response) => {
    res.type("html").send(statusPage(baseUrl));
  });

  // MCP endpoint — stateless: build a fresh server + transport per request.
  // Served at /mcp (the advertised MCP endpoint).
  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    const { server } = createServer(config, client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("Error handling MCP request", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).json(JSON_RPC_METHOD_NOT_ALLOWED);

  app.post("/mcp", handleMcp);
  // Session-based GET/DELETE are not supported in stateless mode.
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // Registered last: JSON errors only, never Express's HTML stack-trace page.
  app.use(jsonErrorHandler(logger));
  return app;
}

export async function runHttp(
  config: RuntimeConfig,
  port: number,
): Promise<void> {
  const logger = createLogger(config);
  const app = createHttpApp(config);
  // Background: replace the snapshot catalog with the live sitemap's, using
  // the same shared client (cache, concurrency cap) the requests use.
  startSitemapRefresh(
    getSharedWebsiteClient(config, logger),
    logger,
    sitemapRefreshMs(),
  );

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port, () => {
      logger.info(
        `${SERVER_NAME} v${SERVER_VERSION} listening on http://localhost:${port}/mcp (market=${config.defaultMarket})`,
      );
      resolve();
    });

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.error(
          `Port ${port} is already in use. Set PORT to a free port, e.g. PORT=3100 npm run start:http`,
        );
      } else {
        logger.error("HTTP server error", err);
      }
      reject(err);
    });

    let shuttingDown = false;
    const shutdown = (reason: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Shutting down (${reason})…`);
      httpServer.close(() => process.exit(0));
      // Force-exit if connections linger.
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
