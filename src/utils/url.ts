/**
 * URL safety and the derived page catalog.
 *
 * SSRF defence: outbound fetches are restricted to the RaivatEdu origin over
 * HTTPS, and only to paths that appear in the verified sitemap-derived catalog.
 * This prevents an agent (or injected page content) from coercing the server
 * into fetching arbitrary internal/external URLs, and honours robots.txt by
 * never touching /api/.
 */

import {
  ALLOWED_HOSTS,
  CANONICAL_HOST,
  DISALLOWED_PATH_PREFIXES,
  FEATURE_SLUGS,
  GLOBAL_PAGES,
  MARKETS,
  MARKET_PAGES,
  RESOURCE_SLUGS,
  SITE_ORIGIN,
  SOLUTION_SLUGS,
  type Market,
} from "../config.js";
import { ValidationError } from "./errors.js";

export interface CatalogPage {
  /** Absolute, canonical URL. */
  url: string;
  /** Path portion, always starting with "/". */
  path: string;
  /** Coarse page category for discovery/search. */
  type:
    | "home"
    | "pricing"
    | "enterprise"
    | "features-index"
    | "feature"
    | "solutions-index"
    | "solution"
    | "product"
    | "integrations"
    | "security"
    | "about"
    | "contact"
    | "demo"
    | "privacy"
    | "terms"
    | "resources-index"
    | "blog"
    | "guides"
    | "help"
    | "resource-article"
    | "careers";
  /** Market this page belongs to, or null for global pages. */
  market: Market | null;
}

const PAGE_TYPE_BY_SLUG: Record<string, CatalogPage["type"]> = {
  "": "home",
  pricing: "pricing",
  enterprise: "enterprise",
  features: "features-index",
  solutions: "solutions-index",
  product: "product",
  integrations: "integrations",
  security: "security",
  about: "about",
  contact: "contact",
  demo: "demo",
  privacy: "privacy",
  terms: "terms",
  resources: "resources-index",
  blog: "blog",
  guides: "guides",
  help: "help",
};

function buildCatalog(): CatalogPage[] {
  const pages: CatalogPage[] = [];

  for (const market of MARKETS) {
    for (const slug of MARKET_PAGES) {
      const path = slug ? `/${market}/${slug}` : `/${market}`;
      pages.push({
        url: `${SITE_ORIGIN}${path}`,
        path,
        type: PAGE_TYPE_BY_SLUG[slug] ?? "home",
        market,
      });
    }
    for (const feature of FEATURE_SLUGS) {
      const path = `/${market}/features/${feature}`;
      pages.push({ url: `${SITE_ORIGIN}${path}`, path, type: "feature", market });
    }
    for (const solution of SOLUTION_SLUGS) {
      const path = `/${market}/solutions/${solution}`;
      pages.push({ url: `${SITE_ORIGIN}${path}`, path, type: "solution", market });
    }
    for (const resource of RESOURCE_SLUGS) {
      const path = `/${market}/resources/${resource}`;
      pages.push({
        url: `${SITE_ORIGIN}${path}`,
        path,
        type: "resource-article",
        market,
      });
    }
  }

  for (const slug of GLOBAL_PAGES) {
    const path = `/${slug}`;
    pages.push({ url: `${SITE_ORIGIN}${path}`, path, type: "careers", market: null });
  }

  return pages;
}

/** Full, immutable catalog of every allowlisted public page. */
export const CATALOG: readonly CatalogPage[] = Object.freeze(buildCatalog());

const CATALOG_BY_PATH: ReadonlyMap<string, CatalogPage> = new Map(
  CATALOG.map((p) => [p.path, p]),
);

/** Normalize a path: ensure leading slash, strip trailing slash, drop query/hash. */
export function normalizePath(input: string): string {
  let p = input.trim();
  // Strip query string and fragment if present.
  const q = p.search(/[?#]/);
  if (q !== -1) p = p.slice(0, q);
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p;
}

/** Return the catalog entry for a path, or undefined if not allowlisted. */
export function lookupPath(path: string): CatalogPage | undefined {
  return CATALOG_BY_PATH.get(normalizePath(path));
}

export function isValidMarket(value: string): value is Market {
  return (MARKETS as readonly string[]).includes(value);
}

/**
 * Resolve an arbitrary caller-supplied page reference (a path like
 * "/in/pricing" OR a full URL on the RaivatEdu origin) to a safe, canonical,
 * allowlisted URL. Throws ValidationError if anything is off.
 */
export function resolveToSafeUrl(reference: string): CatalogPage {
  const raw = reference.trim();
  if (!raw) throw new ValidationError("A page path or URL is required.");

  let path: string;

  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ValidationError(`"${raw}" is not a valid URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ValidationError("Only http(s) URLs are supported.");
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new ValidationError(
        `Refusing to fetch host "${parsed.hostname}". This server only reads pages on ${CANONICAL_HOST}.`,
      );
    }
    path = parsed.pathname;
  } else {
    path = raw;
  }

  path = normalizePath(path);

  for (const bad of DISALLOWED_PATH_PREFIXES) {
    if (path === bad || path.startsWith(bad.endsWith("/") ? bad : `${bad}/`)) {
      throw new ValidationError(
        `Path "${path}" is blocked by robots.txt (Disallow: /api/) and will not be fetched.`,
      );
    }
  }

  const page = CATALOG_BY_PATH.get(path);
  if (!page) {
    throw new ValidationError(
      `Path "${path}" is not a known public RaivatEdu page. ` +
        `Use the raivatedu_list_pages tool to discover valid paths.`,
    );
  }
  return page;
}
