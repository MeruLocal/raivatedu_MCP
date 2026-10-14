# Plan: build the page catalog from the live sitemap at startup, with the 2026-10-13 snapshot as fallback

- **Severity:** P2 (silent drift: new site pages are refused as "not a known public page")
- **Effort:** M
- **Status:** Plan only. Implementation follows after approval.

## Finding

- `src/config.ts:1-160` hard-codes the page catalog "confirmed by inspecting the live site on 2026-10-13":
  - the market pages
  - 9 `FEATURE_SLUGS`, 4 `SOLUTION_SLUGS`, 6 `RESOURCE_SLUGS`
  - `GLOBAL_PAGES`
- `src/utils/url.ts:107` freezes it into `CATALOG`. That catalog is also the SSRF allowlist: `resolveToSafeUrl` refuses any path not in it.
- Any page published after 2026-10-13 is therefore invisible: it is not in `list_pages` or `search`, and `get_page_content` refuses it. A removed page still appears and returns 404.
- Labels (`FEATURE_LABELS`, `SOLUTION_LABELS`) and tool descriptions ("The nine feature areas", `src/tools/catalog.ts`) repeat the counts.

**Not checked:** the current live sitemap contents (unreachable from the sandbox), so I cannot say whether drift has already happened.

## Proposed fix

1. **New `src/services/sitemap.ts`:** `loadCatalogFromSitemap(client)`.
   - Fetch `https://www.raivatedu.com/sitemap.xml` through the existing `WebsiteClient`, which applies the host allowlist, timeout and retries.
   - Follow only `<sitemap><loc>` children on allowed hosts, at most 10, with each XML at most 2 MB and at most 5000 `<loc>` entries in total.
   - Parse with cheerio in `xmlMode` (already a dependency).
   - **Accept a URL only if it matches a known shape.** The sitemap can grow the allowlist, but only along shapes we already trust:
     - `/{market}` or `/{market}/{MARKET_PAGE}`
     - `/{market}/features/{slug}`, `/{market}/solutions/{slug}`, `/{market}/resources/{slug}`
     - `/careers`
     - `{market}` must be in `MARKETS` (the zod enum stays static), and `{slug}` must match `^[a-z0-9-]{1,80}$`
     - never `/api`
   - Return `{ pages: CatalogPage[], source: "sitemap", fetchedAt }`, or throw.
2. **`src/utils/url.ts`:** make the catalog swappable.
   - `let current = SNAPSHOT_CATALOG` (today's `buildCatalog()`), with `getCatalog()` and `setCatalog()`.
   - `lookupPath`, `resolveToSafeUrl` and `pagesForMarket` read `getCatalog()`.
3. **Startup (`src/index.ts`, both transports):**
   - Start the server immediately on the snapshot.
   - Kick off `loadCatalogFromSitemap` in the background. On success, `setCatalog`. On failure, log a warning and keep the snapshot.
   - Refresh every 24 h (`RAIVATEDU_SITEMAP_REFRESH_MS`; 0 turns the sitemap off and keeps the snapshot).
   - Requests never block on the sitemap.
4. **Labels for new slugs:** keep the verified labels for known slugs. For new ones, title-case the slug (the method `list_resources` already uses).
   - Rewrite tool descriptions to drop the hard-coded counts.
   - `list_features`, `list_solutions` and `list_resources` read the slugs from the current catalog.
5. Report `catalog_source: "sitemap" | "snapshot"` and `catalog_fetched_at` in `list_pages` output, so staleness is visible.

## Tests to add (`tests/sitemap.test.ts`, mocked fetch)

- An index with 3 child sitemaps parses to the expected pages. A new feature slug appears in `list_features` and `get_page_content` accepts it.
- These are all rejected:
  - an off-host `<loc>`
  - an unknown market
  - `/api/x`
  - a slug with `..` or uppercase
  - an unknown section `/in/admin/x`
- A sitemap fetch failure keeps the snapshot (`catalog_source: "snapshot"`).
- Oversized or too many entries are truncated safely.
- The existing SSRF tests still pass.

## Risks / founder decisions

- **Security:** the sitemap now feeds the SSRF allowlist. This is mitigated by shape-matching and host checks: a compromised sitemap could at most expose additional same-site public pages.
- One extra startup request (plus up to 3 children) per process per day. Negligible, and the cache plan absorbs it.
- `MARKETS` stays static because it is a zod enum in the tool schemas. A new market still needs a code change. **Founder decision:** acceptable?
