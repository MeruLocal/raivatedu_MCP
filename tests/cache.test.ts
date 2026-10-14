import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  WebsiteClient,
  getSharedWebsiteClient,
  resetSharedWebsiteClient,
} from "../src/services/website-client.js";
import { createLogger } from "../src/utils/logger.js";
import {
  HTTP_DEFAULT_SEARCH_MAX_PAGES,
  SITE_ORIGIN,
  httpConfig,
  loadConfig,
} from "../src/config.js";
import { createServer } from "../src/server.js";
import { selectSearchCandidates } from "../src/tools/pages.js";
import { CATALOG } from "../src/utils/url.js";
import { HOME_HTML } from "./fixtures.js";

const logger = createLogger({ logLevel: "silent" });

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    ...loadConfig({}),
    minRequestIntervalMs: 0,
    maxRetries: 0,
    timeoutMs: 1000,
    ...overrides,
  };
}

const html = () =>
  new Response("<html><head><title>t</title></head><body>x</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetSharedWebsiteClient();
});

describe("page cache", () => {
  it("a repeated GET makes one fetch", async () => {
    const f = vi.fn(async () => html());
    vi.stubGlobal("fetch", f);
    const c = new WebsiteClient(cfg(), logger);
    await c.get(`${SITE_ORIGIN}/in`);
    await c.get(`${SITE_ORIGIN}/in`);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("three concurrent GETs for the same URL share one fetch", async () => {
    const f = vi.fn(async () => html());
    vi.stubGlobal("fetch", f);
    const c = new WebsiteClient(cfg(), logger);
    await Promise.all([1, 2, 3].map(() => c.get(`${SITE_ORIGIN}/in`)));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an entry expires after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = vi.fn(async () => html());
    vi.stubGlobal("fetch", f);
    const c = new WebsiteClient(cfg({ cacheTtlMs: 1000 }), logger);
    await c.get(`${SITE_ORIGIN}/in`);
    vi.setSystemTime(Date.now() + 500);
    await c.get(`${SITE_ORIGIN}/in`);
    expect(f).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1000);
    await c.get(`${SITE_ORIGIN}/in`);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("cacheTtlMs: 0 turns caching off", async () => {
    const f = vi.fn(async () => html());
    vi.stubGlobal("fetch", f);
    const c = new WebsiteClient(cfg({ cacheTtlMs: 0 }), logger);
    await c.get(`${SITE_ORIGIN}/in`);
    await c.get(`${SITE_ORIGIN}/in`);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a 404 is not cached", async () => {
    const f = vi.fn(async () => new Response("no", { status: 404 }));
    vi.stubGlobal("fetch", f);
    const c = new WebsiteClient(cfg(), logger);
    await expect(c.get(`${SITE_ORIGIN}/in`)).rejects.toThrow();
    await expect(c.get(`${SITE_ORIGIN}/in`)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used entry at cacheMaxEntries", async () => {
    const f = vi.fn(async () => html());
    vi.stubGlobal("fetch", f);
    const c = new WebsiteClient(cfg({ cacheMaxEntries: 2 }), logger);
    const a = `${SITE_ORIGIN}/in`;
    const b = `${SITE_ORIGIN}/us`;
    const d = `${SITE_ORIGIN}/gb`;
    await c.get(a);
    await c.get(b);
    await c.get(a); // a is now most recently used
    await c.get(d); // evicts b
    expect(f).toHaveBeenCalledTimes(3);
    await c.get(a);
    expect(f).toHaveBeenCalledTimes(3);
    await c.get(b);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("head() is never cached", async () => {
    const f = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", f);
    const c = new WebsiteClient(cfg(), logger);
    await c.head(`${SITE_ORIGIN}/in`);
    await c.head(`${SITE_ORIGIN}/in`);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("concurrency cap", () => {
  it("peak simultaneous fetches equals maxConcurrentRequests", async () => {
    let active = 0;
    let peak = 0;
    const f = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return html();
    });
    vi.stubGlobal("fetch", f);
    const c = new WebsiteClient(cfg({ maxConcurrentRequests: 3 }), logger);
    const urls = ["in", "us", "gb", "ca", "au", "nz", "ie", "sg", "ae", "za"].map(
      (m) => `${SITE_ORIGIN}/${m}`,
    );
    await Promise.all(urls.map((u) => c.get(u)));
    expect(f).toHaveBeenCalledTimes(10);
    expect(peak).toBe(3);
  });
});

describe("shared client and HTTP config", () => {
  it("getSharedWebsiteClient returns the same instance", () => {
    const a = getSharedWebsiteClient(cfg(), logger);
    const b = getSharedWebsiteClient(cfg(), logger);
    expect(a).toBe(b);
  });

  it("httpConfig lowers the search cap unless the env var is set", () => {
    expect(loadConfig({}).searchMaxPages).toBe(0);
    expect(httpConfig(loadConfig({}), {}).searchMaxPages).toBe(
      HTTP_DEFAULT_SEARCH_MAX_PAGES,
    );
    const env = { RAIVATEDU_SEARCH_MAX_PAGES: "20" };
    expect(httpConfig(loadConfig(env), env).searchMaxPages).toBe(20);
  });
});

describe("selectSearchCandidates", () => {
  const inPages = CATALOG.filter((p) => p.market === "in" || p.market === null);

  it("puts a path match first and respects the cap", () => {
    const picked = selectSearchCandidates(inPages, ["attendance"], 5);
    expect(picked).toHaveLength(5);
    expect(picked[0]!.path).toBe("/in/features/attendance");
    expect(picked[1]!.type).toBe("home");
  });

  it("does not match the market prefix itself", () => {
    const usPages = CATALOG.filter((p) => p.market === "us");
    const picked = selectSearchCandidates(usPages, ["us"], 3);
    expect(picked.map((p) => p.type)).toEqual(["home", "pricing", "product"]);
  });

  it("returns every searchable page when uncapped", () => {
    const all = selectSearchCandidates(inPages, ["zzz"], 0);
    expect(all.length).toBe(28);
  });
});

describe("HTTP-style search integration", () => {
  it("two searches on fresh servers sharing one client make 12 then 0 fetches", async () => {
    const f = vi.fn(async () =>
      new Response(HOME_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", f);
    const config = httpConfig(
      loadConfig({ RAIVATEDU_MIN_REQUEST_INTERVAL_MS: "0", RAIVATEDU_LOG_LEVEL: "silent" }),
      {},
    );
    const shared = getSharedWebsiteClient(config, logger);

    const search = async () => {
      const { server } = createServer(config, shared);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "t", version: "1" });
      await client.connect(ct);
      const res = await client.callTool({
        name: "raivatedu_search_content",
        arguments: { query: "whatsapp", market: "in" },
      });
      await client.close();
      return res;
    };

    await search();
    expect(f).toHaveBeenCalledTimes(12);
    await search();
    expect(f).toHaveBeenCalledTimes(12);
  });
});
