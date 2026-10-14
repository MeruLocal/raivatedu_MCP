/**
 * Guards for the public HTTP endpoint, mounted on /mcp only (so /health, /
 * and the discovery document stay open for probes):
 *
 *  - Host allowlist (DNS-rebinding protection), via the SDK middleware.
 *  - Origin allowlist: no Origin (CLI / server-side clients) and localhost
 *    origins pass; any other browser origin must be listed.
 *  - Per-IP fixed-window rate limit.
 *  - A JSON error handler (registered last) so oversized or malformed bodies
 *    and unexpected errors never fall through to Express's HTML error page,
 *    which prints stack traces and deploy paths when NODE_ENV is unset.
 */

import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { Logger } from "./utils/logger.js";

export const DEFAULT_ALLOWED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "mcp.raivatedu.com",
];

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://mcp.raivatedu.com",
  "https://raivatedu.com",
  "https://www.raivatedu.com",
];

export const DEFAULT_RATE_LIMIT_PER_MIN = 60;

export interface HttpSecurityConfig {
  allowedHosts: string[];
  allowedOrigins: string[];
  /** Requests per minute per client IP; 0 turns the limit off. */
  rateLimitPerMin: number;
  /** Trust the right-most X-Forwarded-For hop (set behind a proxy). */
  trustProxy: boolean;
}

function list(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined || !raw.trim()) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadHttpSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpSecurityConfig {
  const rawLimit = Number.parseInt(env.MCP_RATE_LIMIT_PER_MIN ?? "", 10);
  return {
    allowedHosts: list(env.MCP_ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    allowedOrigins: list(env.MCP_ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS).map(
      (o) => o.replace(/\/+$/, ""),
    ),
    rateLimitPerMin:
      Number.isFinite(rawLimit) && rawLimit >= 0
        ? Math.min(rawLimit, 100000)
        : DEFAULT_RATE_LIMIT_PER_MIN,
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY?.trim() ?? ""),
  };
}

function jsonRpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Host header allowlist (port-agnostic). */
export function hostCheck(allowedHosts: string[]): RequestHandler {
  return hostHeaderValidation(allowedHosts);
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Origin allowlist. Requests without an Origin header pass. */
export function originCheck(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    const normalized = origin.trim().toLowerCase().replace(/\/+$/, "");
    if (allowed.has(normalized) || LOCAL_ORIGIN.test(normalized)) return next();
    jsonRpcError(res, 403, -32000, "Origin not allowed.");
  };
}

/** The key a request is rate-limited by. */
export function clientKey(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    if (raw) {
      const hops = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const last = hops[hops.length - 1];
      if (last) return last;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

const MAX_TRACKED_KEYS = 10000;

/** Fixed one-minute window per client key. */
export function rateLimit(
  perMinute: number,
  trustProxy: boolean,
  now: () => number = Date.now,
): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  const WINDOW_MS = 60000;
  return (req: Request, res: Response, next: NextFunction) => {
    if (perMinute <= 0) return next();
    const t = now();
    if (windows.size > MAX_TRACKED_KEYS) {
      for (const [k, w] of windows) {
        if (t - w.start >= WINDOW_MS) windows.delete(k);
      }
      if (windows.size > MAX_TRACKED_KEYS) windows.clear();
    }
    const key = clientKey(req, trustProxy);
    let w = windows.get(key);
    if (!w || t - w.start >= WINDOW_MS) {
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    w.count++;
    if (w.count > perMinute) {
      const retryAfter = Math.max(1, Math.ceil((w.start + WINDOW_MS - t) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      jsonRpcError(res, 429, -32000, "Too many requests. Slow down and retry later.");
      return;
    }
    next();
  };
}

/** The three request guards for /mcp, in order. */
export function mcpGuards(cfg: HttpSecurityConfig): RequestHandler[] {
  return [
    hostCheck(cfg.allowedHosts),
    originCheck(cfg.allowedOrigins),
    rateLimit(cfg.rateLimitPerMin, cfg.trustProxy),
  ];
}

/**
 * Final error handler: JSON bodies only, never a stack trace or file path.
 */
export function jsonErrorHandler(logger?: Logger): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const type = (err as { type?: string } | null)?.type;
    if (type === "entity.too.large") {
      jsonRpcError(res, 413, -32600, "Request body too large.");
      return;
    }
    if (type === "entity.parse.failed") {
      jsonRpcError(res, 400, -32700, "Parse error: request body is not valid JSON.");
      return;
    }
    const status = (err as { status?: number } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      jsonRpcError(res, status, -32600, "Invalid request.");
      return;
    }
    logger?.error(
      `Unhandled HTTP error: ${err instanceof Error ? err.name : typeof err}`,
    );
    jsonRpcError(res, 500, -32603, "Internal server error");
  };
}
