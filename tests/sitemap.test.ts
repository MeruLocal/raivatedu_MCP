import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MAX_LOCS,
  loadCatalogFromSitemap,
  pageFromLoc,
  sitemapRefreshMs,
  startSitemapRefresh,
} from "../src/services/sitemap.js";
import { WebsiteClient } from "../src/services/website-client.js";
import { createLogger } from "../src/utils/logger.js";
import { loadConfig, MARKETS, MARKET_PAGES, FEATURE_SLUGS, SOLUTION_SLUGS, RESOURCE_SLUGS } from "../src/config.js";
import {
  SNAPSHOT_CATALOG,
  getCatalogState,
  resetCatalog,
  resolveToSafeUrl,
  setCatalog,
} from "../src/utils/url.js";
import { createServer } from "../src/server.js";

const logger = createLogger({ logLevel: "silent" });
const W = "https://www.raivatedu.com";

function client() {
  return new WebsiteClient(
    { ...loadConfig({}), minRequestIntervalMs: 0, maxRetries: 0, timeoutMs: 2000 },
    logger,
  );
}

const xml = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
const urlset = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join("")}</urlset>`;

/** Every snapshot page split across three child sitemaps, plus extras. */
function siteMock(extra: string[] = []) {
  const all = SNAPSHOT_CATALOG.map((p) => p.url);
  const third = Math.ceil(all.length / 3);
  const children: Record<string, string[]> = {
    [`${W}/pages.xml`]: all.slice(0, third),
    [`${W}/markets.xml`]: all.slice(third, 2 * third),
    [`${W}/resources.xml`]: [...all.slice(2 * third), ...extra],
  };
  const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
    ...Object.keys(children),
    "https://evil.example/sitemap.xml",
  ]
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join("")}</sitemapindex>`;
  const f = vi.fn(async (url: string) => {
    if (url === `${W}/sitemap.xml`) return xml(index);
    const c = children[url];
    if (c) return xml(urlset(c));
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCatalog();
});

describe("pageFromLoc", () => {
  it("accepts trusted shapes", () => {
    expect(pageFromLoc(`${W}/in`)?.type).toBe("home");
    expect(pageFromLoc(`${W}/in/pricing/`)?.path).toBe("/in/pricing");
    expect(pageFromLoc(`${W}/us/features/new-thing`)?.type).toBe("feature");
    expect(pageFromLoc(`${W}/in/school-management-software`)?.type).toBe("landing");
    expect(pageFromLoc(`${W}/in/glossary`)?.type).toBe("glossary-index");
    expect(pageFromLoc(`${W}/in/glossary/cbse-full-form`)?.type).toBe("glossary-term");
    expect(pageFromLoc(`${W}/in/glossary/a/b`)).toBeNull();
    expect(pageFromLoc(`${W}/in/not-a-landing-page`)).toBeNull();
    expect(pageFromLoc(`https://raivatedu.com/gb/resources/a-b-c`)?.url).toBe(`${W}/gb/resources/a-b-c`);
    expect(pageFromLoc(`${W}/careers`)?.market).toBeNull();
  });

  it.each([
    ["an off-host loc", "https://evil.example/in/pricing"],
    ["plain http", "http://www.raivatedu.com/in"],
    ["an unknown market", `${W}/xx/pricing`],
    ["an /api path", `${W}/api/x`],
    ["a slug with ..", `${W}/in/features/a..b`],
    ["an uppercase slug", `${W}/in/features/Admissions`],
    ["an unknown section", `${W}/in/admin/x`],
    ["an unknown top-level page", `${W}/in/secret`],
    ["a deeper path", `${W}/in/features/a/b`],
  ])("rejects %s", (_label, loc) => {
    expect(pageFromLoc(loc)).toBeNull();
  });
});

describe("loadCatalogFromSitemap", () => {
  it("parses an index with three child sitemaps and ignores off-host children", async () => {
    const f = siteMock([`${W}/in/features/timetables`, "https://evil.example/in/x"]);
    const cat = await loadCatalogFromSitemap(client());
    expect(cat.source).toBe("sitemap");
    expect(cat.pages.length).toBe(SNAPSHOT_CATALOG.length + 1);
    expect(f.mock.calls.map((c) => c[0])).not.toContain("https://evil.example/sitemap.xml");
  });

  it("a new feature appears in list_features and get_page_content accepts it", async () => {
    siteMock([`${W}/in/features/timetables`]);
    const cat = await loadCatalogFromSitemap(client());
    setCatalog(cat.pages, cat.source, cat.fetchedAt);
    expect(resolveToSafeUrl("/in/features/timetables").type).toBe("feature");

    const { server } = createServer(loadConfig({ RAIVATEDU_LOG_LEVEL: "silent" }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcp = new Client({ name: "t", version: "1" });
    await mcp.connect(ct);
    const res = await mcp.callTool({ name: "raivatedu_list_features", arguments: { market: "in" } });
    const features = (res.structuredContent as { features: { slug: string; label: string }[] }).features;
    expect(features.find((x) => x.slug === "timetables")?.label).toBe("Timetables");
    expect(features.find((x) => x.slug === "admissions")?.label).toBe("Admissions");
    const pages = await mcp.callTool({ name: "raivatedu_list_pages", arguments: { market: "in" } });
    expect((pages.structuredContent as { catalog_source: string }).catalog_source).toBe("sitemap");
  });

  it("refuses a sitemap that yields too few pages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xml(urlset([`${W}/in`]))));
    await expect(loadCatalogFromSitemap(client())).rejects.toThrow(/keeping the snapshot/);
  });

  it("caps the number of <loc> entries read", async () => {
    const many = Array.from({ length: MAX_LOCS + 500 }, (_, i) => `${W}/in/resources/a-${i}`);
    vi.stubGlobal("fetch", vi.fn(async () => xml(urlset(many))));
    const cat = await loadCatalogFromSitemap(client());
    expect(cat.pages.length).toBe(MAX_LOCS);
  });

  it("an oversized sitemap is refused by the client's response cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("x", {
          headers: { "content-type": "application/xml", "content-length": String(5 * 1024 * 1024) },
        }),
      ),
    );
    await expect(loadCatalogFromSitemap(client())).rejects.toThrow(/too large/);
  });
});

describe("startSitemapRefresh", () => {
  it("keeps the snapshot when the sitemap fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const stop = startSitemapRefresh(client(), logger, 60_000);
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(getCatalogState().source).toBe("snapshot");
    expect(resolveToSafeUrl("/in/pricing").type).toBe("pricing");
  });

  it("swaps in the sitemap catalog on success", async () => {
    siteMock();
    const stop = startSitemapRefresh(client(), logger, 60_000);
    await vi.waitFor(() => expect(getCatalogState().source).toBe("sitemap"));
    stop();
  });

  it("interval 0 turns the sitemap off", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    startSitemapRefresh(client(), logger, 0)();
    expect(f).not.toHaveBeenCalled();
    expect(sitemapRefreshMs({ RAIVATEDU_SITEMAP_REFRESH_MS: "0" })).toBe(0);
    expect(sitemapRefreshMs({})).toBe(86_400_000);
  });
});

describe("snapshot sanity", () => {
  it("covers every market page and detail slug", () => {
    const expected =
      MARKETS.length *
        (MARKET_PAGES.length + FEATURE_SLUGS.length + SOLUTION_SLUGS.length + RESOURCE_SLUGS.length) +
      1;
    expect(SNAPSHOT_CATALOG.length).toBe(expected);
  });
});
