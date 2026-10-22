/**
 * Build the page catalog from the live sitemap, so pages published after the
 * 2026-10-13 snapshot become reachable and removed pages drop out.
 *
 * SECURITY: the catalog is also the SSRF allowlist, so a sitemap entry is
 * accepted only if it matches a shape we already trust (a known market, a
 * known top-level page, or a lowercase slug under features/solutions/
 * resources, or /careers) on an allowed host, and never /api. A tampered
 * sitemap can at most expose more same-site public pages.
 */

import * as cheerio from "cheerio";
import {
  ALLOWED_HOSTS,
  GLOBAL_PAGES,
  MARKET_PAGES,
  SITE_ORIGIN,
  type Market,
} from "../config.js";
import type { WebsiteClient } from "./website-client.js";
import type { Logger } from "../utils/logger.js";
import {
  PAGE_TYPE_BY_SLUG,
  SNAPSHOT_CATALOG,
  isValidMarket,
  normalizePath,
  setCatalog,
  type CatalogPage,
} from "../utils/url.js";

export const SITEMAP_URL = `${SITE_ORIGIN}/sitemap.xml`;
export const MAX_CHILD_SITEMAPS = 10;
export const MAX_LOCS = 5000;
/** A sitemap that yields fewer pages than this share of the snapshot is distrusted. */
const MIN_SHARE_OF_SNAPSHOT = 0.5;

const SLUG = /^[a-z0-9-]{1,80}$/;
const DETAIL_TYPES: Record<string, CatalogPage["type"]> = {
  features: "feature",
  solutions: "solution",
  resources: "resource-article",
  glossary: "glossary-term",
};

export interface SitemapCatalog {
  pages: CatalogPage[];
  source: "sitemap";
  fetchedAt: string;
}

/** Map one sitemap <loc> to a catalog page, or null if it is not a trusted shape. */
export function pageFromLoc(loc: string): CatalogPage | null {
  let u: URL;
  try {
    u = new URL(loc.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
  const path = normalizePath(u.pathname);
  if (path === "/api" || path.startsWith("/api/")) return null;
  const parts = path.split("/").slice(1);
  const make = (type: CatalogPage["type"], market: Market | null): CatalogPage => ({
    url: `${SITE_ORIGIN}${path}`,
    path,
    type,
    market,
  });

  if (parts.length === 1 && (GLOBAL_PAGES as readonly string[]).includes(parts[0]!)) {
    return make("careers", null);
  }
  const [market, section, slug, ...rest] = parts;
  if (!market || !isValidMarket(market) || rest.length > 0) return null;
  if (section === undefined) return make("home", market);
  if (slug === undefined) {
    if (!section || !(MARKET_PAGES as readonly string[]).includes(section)) return null;
    const type = PAGE_TYPE_BY_SLUG[section];
    return type ? make(type, market) : null;
  }
  const detail = DETAIL_TYPES[section];
  if (!detail || !SLUG.test(slug)) return null;
  return make(detail, market);
}

function locs(xml: string, selector: string): string[] {
  const $ = cheerio.load(xml, { xml: true });
  const out: string[] = [];
  $(selector).each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.push(t);
  });
  return out;
}

function isAllowedSitemapUrl(loc: string): boolean {
  try {
    const u = new URL(loc);
    return (
      u.protocol === "https:" &&
      ALLOWED_HOSTS.has(u.hostname.toLowerCase()) &&
      !u.pathname.startsWith("/api")
    );
  } catch {
    return false;
  }
}

/**
 * Fetch the sitemap (index + up to 10 children on allowed hosts) through the
 * website client (allowlist, timeout, retries, 2 MB cap) and build a catalog.
 * Throws when nothing usable comes back.
 */
export async function loadCatalogFromSitemap(
  client: WebsiteClient,
  url: string = SITEMAP_URL,
): Promise<SitemapCatalog> {
  const { body } = await client.get(url);
  let pageLocs = locs(body, "urlset > url > loc");
  const children = locs(body, "sitemapindex > sitemap > loc")
    .filter(isAllowedSitemapUrl)
    .slice(0, MAX_CHILD_SITEMAPS);
  for (const child of children) {
    if (pageLocs.length >= MAX_LOCS) break;
    const res = await client.get(child);
    pageLocs = pageLocs.concat(locs(res.body, "urlset > url > loc"));
  }
  pageLocs = pageLocs.slice(0, MAX_LOCS);

  const byPath = new Map<string, CatalogPage>();
  for (const loc of pageLocs) {
    const page = pageFromLoc(loc);
    if (page && !byPath.has(page.path)) byPath.set(page.path, page);
  }
  const pages = [...byPath.values()];
  if (pages.length < SNAPSHOT_CATALOG.length * MIN_SHARE_OF_SNAPSHOT) {
    throw new Error(
      `Sitemap yielded only ${pages.length} usable pages (snapshot has ${SNAPSHOT_CATALOG.length}); keeping the snapshot.`,
    );
  }
  return { pages, source: "sitemap", fetchedAt: new Date().toISOString() };
}

/** Refresh interval for the sitemap catalog, from RAIVATEDU_SITEMAP_REFRESH_MS. */
export function sitemapRefreshMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RAIVATEDU_SITEMAP_REFRESH_MS?.trim();
  if (!raw) return 24 * 60 * 60 * 1000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 24 * 60 * 60 * 1000;
  if (n === 0) return 0;
  return Math.max(60_000, n);
}

/**
 * Load the sitemap catalog in the background now and every `intervalMs`.
 * Never blocks requests: the snapshot serves until a load succeeds, and a
 * failed load keeps whatever catalog is in force. Returns a stop function.
 * intervalMs 0 turns the sitemap off (snapshot only).
 */
export function startSitemapRefresh(
  client: WebsiteClient,
  logger: Logger,
  intervalMs: number,
): () => void {
  if (intervalMs <= 0) {
    logger.info("Sitemap catalog disabled; serving the verified snapshot.");
    return () => undefined;
  }
  let stopped = false;
  const run = async () => {
    try {
      const cat = await loadCatalogFromSitemap(client);
      if (stopped) return;
      setCatalog(cat.pages, cat.source, cat.fetchedAt);
      logger.info(`Page catalog loaded from sitemap (${cat.pages.length} pages).`);
    } catch (err) {
      logger.warn(
        `Sitemap catalog load failed; keeping the current catalog: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
