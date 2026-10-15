/**
 * Anonymous tool-usage records: one JSON line per tool call on stderr, with a
 * fixed `event: "tool_call"` key so any log shipper can count them.
 *
 * PRIVACY: arguments are never recorded except `market` (a closed enum).
 * Queries, paths and other free text are excluded (a search query can hold
 * personal data). IP addresses are not recorded. `errorKind` comes from the
 * error class, never from message text.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MARKETS, type RuntimeConfig } from "../config.js";
import { errorKindOfResult, type ErrorKind } from "./errors.js";

export type Transport = "stdio" | "http";

export interface ToolCallRecord {
  tool: string;
  client: string;
  clientVersion?: string;
  transport: Transport;
  market?: string;
  ok: boolean;
  errorKind?: ErrorKind;
  latencyMs: number;
}

export type LineWriter = (line: string) => void;

const stderrWriter: LineWriter = (line) => {
  process.stderr.write(line + "\n");
};

/** Write one usage record as a JSON line. */
export function recordToolCall(rec: ToolCallRecord, write: LineWriter = stderrWriter): void {
  write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "tool_call",
      ...rec,
    }),
  );
}

/**
 * Whether usage records are written. RAIVATEDU_USAGE_LOG=0/1 forces it off
 * or on; unset means on for HTTP and off for stdio (a user's own machine).
 * Records are info-level, so a log level above info also silences them.
 */
export function usageEnabled(config: RuntimeConfig, transport: Transport): boolean {
  if (config.logLevel === "warn" || config.logLevel === "error" || config.logLevel === "silent") {
    return false;
  }
  if (config.usageLog !== undefined) return config.usageLog;
  return transport === "http";
}

/** Keep a client label short and plain: at most 80 chars of [A-Za-z0-9._/ -]. */
export function sanitizeClientLabel(raw: string | undefined): string {
  if (!raw) return "unknown";
  const clean = raw.replace(/[^A-Za-z0-9._/ -]/g, "").trim().slice(0, 80);
  return clean || "unknown";
}

interface HandlerExtra {
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
}

/**
 * Return a view of `server` whose registerTool wraps every handler with
 * timing and outcome logging, so tools need no per-tool edits.
 */
export function withUsageLogging(
  server: McpServer,
  transport: Transport,
  write: LineWriter = stderrWriter,
): McpServer {
  const wrap =
    (tool: string, handler: (...a: unknown[]) => unknown) =>
    async (...a: unknown[]) => {
      const started = Date.now();
      const args = (a.length > 1 ? a[0] : undefined) as Record<string, unknown> | undefined;
      const extra = a[a.length - 1] as HandlerExtra | undefined;
      let result: unknown;
      let thrown = false;
      try {
        result = await handler(...a);
        return result;
      } catch (err) {
        thrown = true;
        throw err;
      } finally {
        const info = server.server.getClientVersion();
        const ua = extra?.requestInfo?.headers?.["user-agent"];
        const market =
          typeof args?.market === "string" && (MARKETS as readonly string[]).includes(args.market)
            ? args.market
            : undefined;
        const isError =
          thrown || (typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true);
        recordToolCall(
          {
            tool,
            client: sanitizeClientLabel(info?.name ?? (Array.isArray(ua) ? ua[0] : ua)),
            ...(info?.version ? { clientVersion: sanitizeClientLabel(info.version) } : {}),
            transport,
            ...(market ? { market } : {}),
            ok: !isError,
            ...(isError
              ? {
                  errorKind:
                    (!thrown && result && typeof result === "object"
                      ? errorKindOfResult(result)
                      : undefined) ?? "internal",
                }
              : {}),
            latencyMs: Date.now() - started,
          },
          write,
        );
      }
    };

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
          (target.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown).call(
            target,
            name,
            config,
            wrap(name, cb),
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
