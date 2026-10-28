/**
 * Streamable HTTP transport for the RaivatEdu MCP server.
 *
 * Runs the server over HTTP (default port 3000) instead of stdio, so it can be
 * reached at http://localhost:3000/mcp by HTTP-capable MCP clients and the MCP
 * Inspector. Uses the stateless JSON pattern (a fresh server + transport per
 * request) which is simple to scale and avoids request-id collisions.
 *
 * Endpoints:
 *   POST /mcp     – MCP JSON-RPC (the endpoint clients connect to)
 *   GET  /health  – liveness probe (JSON)
 *   GET  /        – human-friendly status page
 */

import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, SERVER_VERSION, type RuntimeConfig } from "./config.js";
import { createServer } from "./server.js";
import { createLogger } from "./utils/logger.js";

const JSON_RPC_METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0" as const,
  error: {
    code: -32000,
    message:
      "This server is stateless — send MCP requests as HTTP POST to /mcp.",
  },
  id: null,
};

/**
 * True when the request looks like a browser navigating to the URL rather than a
 * client speaking the protocol. `Sec-Fetch-*` are sent by current browsers; the
 * Accept check covers older ones and excludes a genuine SSE stream request.
 */
function isBrowserNavigation(headers: Request["headers"]): boolean {
  if (headers["sec-fetch-mode"] === "navigate") return true;
  if (headers["sec-fetch-dest"] === "document") return true;
  const accept = String(headers.accept ?? "");
  return accept.includes("text/html") && !accept.includes("text/event-stream");
}

function statusPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RaivatEdu Education MCP Server</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    max-width:820px;margin:0 auto;padding:4rem 1.5rem;line-height:1.65;
    color:#1a1a1a;background:#fff;font-size:17px;
  }
  h1{font-size:2.3rem;line-height:1.25;font-weight:700;margin:0 0 1.6rem;letter-spacing:-.01em}
  p{margin:1.1rem 0}
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
  <h1>RaivatEdu Website &amp; Product Knowledge MCP Server</h1>

  <p>Read-only RaivatEdu website mirror (product knowledge: pricing, features,
  solutions, resources, comparisons) plus site navigation and reachability tools.
  Connect via the Streamable HTTP endpoint at <code>/mcp</code>. No API key is
  required &mdash; this server holds no customer data and performs no account actions.</p>

  <p>Status: <a href="/version">/version</a> &middot; Discovery:
  <a href="/.well-known/mcp.json">/.well-known/mcp.json</a> &middot; Tools:
  <code>POST /mcp</code> &rarr; <code>tools/list</code></p>

  <p class="fine">This is not a student or admissions API. It holds no customer
  data, performs no account actions, and needs no API key &mdash; never send one here.</p>

  <p>Read-only RaivatEdu website mirror (product knowledge: pricing, features,
  solutions, resources, comparisons) plus site navigation and reachability tools.
  Connect via the Streamable HTTP endpoint at <code>/mcp</code>. No API key is
  required, and the public endpoint returns no personal data. This is not an
  admissions API and it performs no account actions &mdash; never send credentials here.</p>

  <p>Content-management tools and the tools that read newsletter subscribers or
  contact-form submissions are not served on this endpoint; they require an
  authenticated session.</p>

  <p>Status: <a href="/version">/version</a> &middot; Health: <a href="/health">/health</a></p>
</body></html>`;
}

/** Minimal discovery document advertised at /.well-known/mcp.json. */
function discoveryDoc(port: number) {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description:
      "Read-only MCP server for the public RaivatEdu education-software website (raivatedu.com).",
    transport: {
      type: "streamable-http",
      endpoint: `http://localhost:${port}/mcp`,
    },
    authentication: "none",
    readOnly: true,
    documentation: "https://www.raivatedu.com",
  };
}

export async function runHttp(
  config: RuntimeConfig,
  port: number,
): Promise<void> {
  const logger = createLogger(config);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.get("/version", (_req: Request, res: Response) => {
    res.json({ name: SERVER_NAME, version: SERVER_VERSION });
  });

  app.get("/.well-known/mcp.json", (_req: Request, res: Response) => {
    res.json(discoveryDoc(port));
  });

  app.get("/", (_req: Request, res: Response) => {
    res.type("html").send(statusPage());
  });

  // MCP endpoint — stateless: build a fresh server + transport per request.
  // Served at /mcp (the advertised MCP endpoint).
  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    const { server } = createServer(config);
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

  // A browser address bar sends GET, so show the status page rather than a bare
  // JSON-RPC error; real clients get a 405 that names the method to use.
  const methodNotAllowed = (req: Request, res: Response) => {
    if (req.method === "GET" && isBrowserNavigation(req.headers)) {
      res.type("html").send(statusPage());
      return;
    }
    res.set("Allow", "POST").status(405).json(JSON_RPC_METHOD_NOT_ALLOWED);
  };

  app.post("/mcp", handleMcp);
  // Session-based GET/DELETE are not supported in stateless mode.
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

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
