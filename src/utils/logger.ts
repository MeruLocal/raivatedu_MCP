/**
 * Minimal leveled logger that writes ONLY to stderr.
 *
 * stdout is reserved for the MCP JSON-RPC protocol stream when using the stdio
 * transport, so anything written there would corrupt the protocol. Every
 * diagnostic therefore goes to stderr.
 */

import type { RuntimeConfig } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;

type Level = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

function format(level: Level, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (meta === undefined) return base;
  try {
    return `${base} ${typeof meta === "string" ? meta : JSON.stringify(meta)}`;
  } catch {
    return `${base} [unserializable meta]`;
  }
}

export function createLogger(config: Pick<RuntimeConfig, "logLevel">): Logger {
  const threshold = LEVELS[config.logLevel];

  const emit = (level: Exclude<Level, "silent">, msg: string, meta?: unknown) => {
    if (LEVELS[level] < threshold) return;
    // eslint-disable-next-line no-console
    process.stderr.write(format(level, msg, meta) + "\n");
  };

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
