import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { sanitizeClientLabel, usageEnabled } from "../src/utils/usage.js";
import { HOME_HTML } from "./fixtures.js";

/** Capture everything written to stderr while `fn` runs. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

const records = (out: string) =>
  out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === "tool_call");

async function makeClient(env: Record<string, string>, transport: "stdio" | "http") {
  const { server } = createServer(
    loadConfig({ RAIVATEDU_MIN_REQUEST_INTERVAL_MS: "0", RAIVATEDU_MAX_RETRIES: "0", ...env }),
    undefined,
    transport,
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "Example-Agent", version: "2.1" });
  await client.connect(ct);
  return client;
}

afterEach(() => vi.unstubAllGlobals());

describe("usage records", () => {
  it("a successful call emits one tool_call line", async () => {
    const client = await makeClient({ RAIVATEDU_LOG_LEVEL: "info" }, "http");
    const out = await captureStderr(async () => {
      await client.callTool({ name: "raivatedu_list_pages", arguments: { market: "us" } });
    });
    const recs = records(out);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      event: "tool_call",
      tool: "raivatedu_list_pages",
      ok: true,
      transport: "http",
      market: "us",
      client: "Example-Agent",
      clientVersion: "2.1",
    });
    expect(typeof recs[0].latencyMs).toBe("number");
  });

  it("a validation failure emits ok:false with errorKind validation", async () => {
    const client = await makeClient({ RAIVATEDU_LOG_LEVEL: "info" }, "http");
    const out = await captureStderr(async () => {
      await client.callTool({ name: "raivatedu_get_page_content", arguments: { path: "/in/nope" } });
    });
    expect(records(out)[0]).toMatchObject({ ok: false, errorKind: "validation" });
  });

  it("an unreachable site emits errorKind upstream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const client = await makeClient({ RAIVATEDU_LOG_LEVEL: "info" }, "http");
    const out = await captureStderr(async () => {
      await client.callTool({ name: "raivatedu_get_pricing", arguments: {} });
    });
    expect(records(out)[0]).toMatchObject({ ok: false, errorKind: "upstream" });
  });

  it("never records the search query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(HOME_HTML, { headers: { "content-type": "text/html" } })),
    );
    const client = await makeClient({ RAIVATEDU_LOG_LEVEL: "info" }, "http");
    const secret = "jane.doe@example.com";
    const out = await captureStderr(async () => {
      await client.callTool({ name: "raivatedu_search_content", arguments: { query: `admissions ${secret}` } });
    });
    expect(records(out)).toHaveLength(1);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("jane");
  });

  it("RAIVATEDU_USAGE_LOG=0 emits nothing", async () => {
    const client = await makeClient({ RAIVATEDU_LOG_LEVEL: "info", RAIVATEDU_USAGE_LOG: "0" }, "http");
    const out = await captureStderr(async () => {
      await client.callTool({ name: "raivatedu_list_pages", arguments: {} });
    });
    expect(records(out)).toHaveLength(0);
  });

  it("the stdio default emits nothing", async () => {
    const client = await makeClient({ RAIVATEDU_LOG_LEVEL: "info" }, "stdio");
    const out = await captureStderr(async () => {
      await client.callTool({ name: "raivatedu_list_pages", arguments: {} });
    });
    expect(records(out)).toHaveLength(0);
  });

  it("RAIVATEDU_USAGE_LOG=1 turns it on for stdio", () => {
    expect(usageEnabled(loadConfig({ RAIVATEDU_USAGE_LOG: "1" }), "stdio")).toBe(true);
    expect(usageEnabled(loadConfig({}), "http")).toBe(true);
    expect(usageEnabled(loadConfig({ RAIVATEDU_LOG_LEVEL: "silent" }), "http")).toBe(false);
  });

  it("sanitizes client labels", () => {
    expect(sanitizeClientLabel("curl/8.0 <script>")).toBe("curl/8.0 script");
    expect(sanitizeClientLabel("x".repeat(200))).toHaveLength(80);
    expect(sanitizeClientLabel(undefined)).toBe("unknown");
  });
});
