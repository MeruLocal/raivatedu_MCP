/**
 * Central configuration and the verified catalog of public RaivatEdu pages.
 *
 * Everything in this file was confirmed by inspecting the live site on
 * 2026-10-13: robots.txt, /sitemap.xml and its three child sitemaps
 * (pages.xml, markets.xml, resources.xml), and the JSON-LD embedded in each
 * page. No endpoints, markets, or page slugs here are invented — they all come
 * straight from the sitemap. See README "Verified website capability analysis".
 */

import { readFileSync } from "node:fs";

/** Canonical host the site serves from (sitemap uses the www host). */
export const CANONICAL_HOST = "www.raivatedu.com";

/** Hosts we are willing to fetch from. Both resolve to the same site. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "raivatedu.com",
  "www.raivatedu.com",
]);

export const SITE_ORIGIN = `https://${CANONICAL_HOST}`;

/**
 * Path prefixes that must never be fetched. robots.txt disallows /api/ for
 * every crawler, so we honour that regardless of how a tool is called.
 */
export const DISALLOWED_PATH_PREFIXES: readonly string[] = ["/api/", "/api"];

/**
 * Markets (locale segments) the site publishes, from markets.xml.
 * Each market has an identical page set with localized copy and currency.
 */
export const MARKETS = [
  "in",
  "us",
  "gb",
  "ca",
  "au",
  "nz",
  "ie",
  "sg",
  "ae",
  "za",
] as const;

export type Market = (typeof MARKETS)[number];

/** Human-readable market names and the currency each market prices in. */
export const MARKET_INFO: Record<Market, { name: string; currency: string }> = {
  in: { name: "India", currency: "INR" },
  us: { name: "United States", currency: "USD" },
  gb: { name: "United Kingdom", currency: "GBP" },
  ca: { name: "Canada", currency: "CAD" },
  au: { name: "Australia", currency: "AUD" },
  nz: { name: "New Zealand", currency: "NZD" },
  ie: { name: "Ireland", currency: "EUR" },
  sg: { name: "Singapore", currency: "SGD" },
  ae: { name: "United Arab Emirates", currency: "AED" },
  za: { name: "South Africa", currency: "ZAR" },
};

/**
 * Top-level pages that exist under every market, e.g. /in, /in/pricing.
 * The empty string is the market home page itself (/in).
 */
export const MARKET_PAGES = [
  "", // market home
  "pricing",
  "enterprise",
  "features",
  "solutions",
  "product",
  "integrations",
  "security",
  "about",
  "contact",
  "demo",
  "privacy",
  "terms",
  "resources",
  "blog",
  "guides",
  "help",
] as const;

/** Feature detail pages, from pages.xml (/features/<slug>). */
export const FEATURE_SLUGS = [
  "fee-management",
  "students-and-batches",
  "admissions",
  "enrolment-and-renewals",
  "attendance",
  "certificates",
  "communication",
  "reports",
  "platform-and-security",
] as const;

export type FeatureSlug = (typeof FEATURE_SLUGS)[number];

/** Verified display labels for each feature area (from site navigation). */
export const FEATURE_LABELS: Record<FeatureSlug, string> = {
  "fee-management": "Fee management",
  "students-and-batches": "Students & batches",
  admissions: "Admissions",
  "enrolment-and-renewals": "Enrolment & renewals",
  attendance: "Attendance",
  certificates: "Certificates",
  communication: "Communication",
  reports: "Reports",
  "platform-and-security": "Platform & security",
};

/** Solution detail pages, from pages.xml (/solutions/<slug>). */
export const SOLUTION_SLUGS = [
  "schools",
  "colleges-universities",
  "coaching-institutes",
  "training-edtech",
] as const;

export type SolutionSlug = (typeof SOLUTION_SLUGS)[number];

/** Verified display labels for each solution/audience (from site navigation). */
export const SOLUTION_LABELS: Record<SolutionSlug, string> = {
  schools: "Schools",
  "colleges-universities": "Colleges & Universities",
  "coaching-institutes": "Coaching Institutes",
  "training-edtech": "Training & EdTech",
};

/** Resource article pages, from resources.xml (/resources/<slug>). */
export const RESOURCE_SLUGS = [
  "first-response-time-admissions",
  "whatsapp-templates-for-admissions",
  "migrating-from-spreadsheets",
  "admissions-funnel-metrics",
  "parents-in-the-admissions-journey",
  "counsellor-productivity-without-micromanaging",
] as const;

export type ResourceSlug = (typeof RESOURCE_SLUGS)[number];

/**
 * Global pages that are NOT market-scoped (they appear only unprefixed in
 * pages.xml). "careers" is the only one.
 */
export const GLOBAL_PAGES = ["careers"] as const;

/** Maximum characters returned in any single tool response body. */
export const CHARACTER_LIMIT = 25000;

/** Runtime configuration resolved from environment variables. */
export interface RuntimeConfig {
  defaultMarket: Market;
  timeoutMs: number;
  minRequestIntervalMs: number;
  maxRetries: number;
  userAgent: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  /** How long a successful GET stays cached, in ms. 0 turns the cache off. */
  cacheTtlMs: number;
  /** Maximum number of cached pages (least recently used is evicted). */
  cacheMaxEntries: number;
  /** Ceiling on simultaneous outbound requests to the website. */
  maxConcurrentRequests: number;
  /** Maximum pages one search may fetch. 0 means no cap. */
  searchMaxPages: number;
  /** Maximum bytes read from one website response. */
  maxResponseBytes: number;
}

/** Search cap applied on the anonymous HTTP transport unless overridden. */
export const HTTP_DEFAULT_SEARCH_MAX_PAGES = 12;

export const SERVER_NAME = "raivat-education-mcp-server";
/**
 * Version, read from package.json at runtime so a version bump cannot leave
 * the User-Agent, /version, /health or --version stale. Works from src/ (tsx,
 * tests) and dist/ alike, since both sit one level below package.json.
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = readPackageVersion();

const DEFAULT_USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (+https://raivatedu.com; read-only MCP client)`;

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Read and validate configuration from `process.env`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const marketRaw = (env.RAIVATEDU_DEFAULT_MARKET ?? "in").toLowerCase();
  const defaultMarket = (MARKETS as readonly string[]).includes(marketRaw)
    ? (marketRaw as Market)
    : "in";

  const logLevelRaw = (env.RAIVATEDU_LOG_LEVEL ?? "info").toLowerCase();
  const logLevel = (
    ["debug", "info", "warn", "error", "silent"].includes(logLevelRaw)
      ? logLevelRaw
      : "info"
  ) as RuntimeConfig["logLevel"];

  return {
    defaultMarket,
    timeoutMs: clampInt(env.RAIVATEDU_TIMEOUT_MS, 15000, 1000, 60000),
    minRequestIntervalMs: clampInt(
      env.RAIVATEDU_MIN_REQUEST_INTERVAL_MS,
      250,
      0,
      10000,
    ),
    maxRetries: clampInt(env.RAIVATEDU_MAX_RETRIES, 2, 0, 5),
    userAgent: env.RAIVATEDU_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    logLevel,
    cacheTtlMs: clampInt(env.RAIVATEDU_CACHE_TTL_MS, 600000, 0, 3600000),
    cacheMaxEntries: clampInt(env.RAIVATEDU_CACHE_MAX_ENTRIES, 500, 1, 10000),
    maxConcurrentRequests: clampInt(
      env.RAIVATEDU_MAX_CONCURRENT_REQUESTS,
      4,
      1,
      32,
    ),
    searchMaxPages: clampInt(env.RAIVATEDU_SEARCH_MAX_PAGES, 0, 0, 200),
    maxResponseBytes: clampInt(
      env.RAIVATEDU_MAX_RESPONSE_BYTES,
      2 * 1024 * 1024,
      64 * 1024,
      16 * 1024 * 1024,
    ),
  };
}

/**
 * Adjust a config for the public HTTP transport, where callers are anonymous:
 * the search fan-out is capped unless RAIVATEDU_SEARCH_MAX_PAGES is set.
 */
export function httpConfig(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  if (env.RAIVATEDU_SEARCH_MAX_PAGES?.trim()) return config;
  return { ...config, searchMaxPages: HTTP_DEFAULT_SEARCH_MAX_PAGES };
}
