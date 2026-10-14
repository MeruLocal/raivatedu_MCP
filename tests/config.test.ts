import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies sensible defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.defaultMarket).toBe("in");
    expect(cfg.timeoutMs).toBe(15000);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.minRequestIntervalMs).toBe(250);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.userAgent).toContain("raivat-education-mcp-server");
  });

  it("accepts a valid market and lowercases it", () => {
    expect(loadConfig({ RAIVATEDU_DEFAULT_MARKET: "US" }).defaultMarket).toBe("us");
  });

  it("falls back to 'in' for an unknown market", () => {
    expect(loadConfig({ RAIVATEDU_DEFAULT_MARKET: "xx" }).defaultMarket).toBe("in");
  });

  it("clamps numeric settings to their allowed ranges", () => {
    expect(loadConfig({ RAIVATEDU_TIMEOUT_MS: "999999" }).timeoutMs).toBe(60000);
    expect(loadConfig({ RAIVATEDU_TIMEOUT_MS: "10" }).timeoutMs).toBe(1000);
    expect(loadConfig({ RAIVATEDU_MAX_RETRIES: "99" }).maxRetries).toBe(5);
    expect(loadConfig({ RAIVATEDU_TIMEOUT_MS: "notanumber" }).timeoutMs).toBe(15000);
  });

  it("honours a custom user agent and log level", () => {
    const cfg = loadConfig({
      RAIVATEDU_USER_AGENT: "custom/1.0",
      RAIVATEDU_LOG_LEVEL: "debug",
    });
    expect(cfg.userAgent).toBe("custom/1.0");
    expect(cfg.logLevel).toBe("debug");
  });

  it("ignores an invalid log level", () => {
    expect(loadConfig({ RAIVATEDU_LOG_LEVEL: "loud" }).logLevel).toBe("info");
  });
});
