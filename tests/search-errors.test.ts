import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { HOME_HTML } from "./fixtures.js";

// Let a test make the parser throw, to prove parser bugs are not swallowed.
const parserState = vi.hoisted(() => ({ explode: false }));
vi.mock("../src/services/content-parser.js", async (orig) => {
  const mod = await orig<typeof import("../src/services/content-parser.js")>();
  return {
    ...mod,
    parsePage: (html: string, max?: number) => {
      if (parserState.explode) throw new Error("parser bug");
      return mod.parsePage(html, max);
    },
  };
});

const ok = () =>
  new Response(HOME_HTML, { status: 200, headers: { "content-type": "text/html" } });

async function makeClient() {
  const { server } = createServer(
    loadConfig({
      RAIVATEDU_MIN_REQUEST_INTERVAL_MS: "0",
      RAIVATEDU_MAX_RETRIES: "0",
      RAIVATEDU_LOG_LEVEL: "silent",
    }),
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
  return client;
}

const text = (res: { content?: unknown }) =>
  ((res.content as { text: string }[])[0] ?? { text: "" }).text;

afterEach(() => {
  vi.unstubAllGlobals();
  parserState.explode = false;
});

describe("search_content when the site cannot be fetched", () => {
  it("returns an error, not 'no matches', when every fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const client = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_search_content",
      arguments: { query: "attendance", market: "in" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Could not reach raivatedu.com/);
    expect(text(res)).not.toMatch(/No matching pages/);
    expect(text(res)).not.toMatch(/fetch failed/);
    expect(text(res)).toMatch(/site unreachable/);
  });

  it("reports partial failures with pages_failed and a note", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++n <= 3 ? new Response("down", { status: 503 }) : ok())),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_search_content",
      arguments: { query: "whatsapp", market: "in" },
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as Record<string, unknown>;
    expect(data.pages_failed).toBe(3);
    expect(data.note).toMatch(/3 of \d+ pages could not be fetched; results may be incomplete/);
    expect(text(res)).toMatch(/may be incomplete/);
    expect(data.count).toBeGreaterThan(0);
  });

  it("has no note and pages_failed 0 when every fetch succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const client = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_search_content",
      arguments: { query: "whatsapp", market: "in" },
    });
    const data = res.structuredContent as Record<string, unknown>;
    expect(data.pages_failed).toBe(0);
    expect(data.note).toBeUndefined();
  });

  it("does not swallow a parser exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    parserState.explode = true;
    const client = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_search_content",
      arguments: { query: "whatsapp", market: "in" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/parser bug/);
  });
});

describe("list tools with include_descriptions when the site is down", () => {
  it("counts unavailable descriptions and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const client = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_list_features",
      arguments: { include_descriptions: true },
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as Record<string, unknown>;
    expect(data.descriptions_unavailable).toBe(9);
    expect(text(res)).toMatch(/descriptions could not be fetched/);
  });

  it("reports 0 unavailable when all descriptions load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const client = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_list_solutions",
      arguments: { include_descriptions: true },
    });
    const data = res.structuredContent as Record<string, unknown>;
    expect(data.descriptions_unavailable).toBe(0);
    expect(data.note).toBeUndefined();
  });
});
