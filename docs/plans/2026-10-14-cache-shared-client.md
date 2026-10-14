# Plan: share one website client with a page cache and outbound concurrency cap

- **Severity:** P1 (each public caller can multiply load on raivatedu.com)
- **Effort:** M
- **Status:** Plan only. Implementation follows after approval.

## Finding

- `src/server.ts:21` creates a new `WebsiteClient` inside `createServer()`.
- `src/http.ts:128` calls `createServer(config)` for **every** HTTP request (stateless pattern).
- So the polite throttle (`minRequestIntervalMs`, 250 ms) only spaces requests *within one MCP request*. N concurrent callers mean N independent throttles and no global ceiling.
- There is no cache anywhere. Every tool call re-fetches the pages it needs.
- `raivatedu_search_content` (`src/tools/pages.ts:263-275`) fetches every searchable page for a market with `Promise.all`. That is 28 pages per call (the tool description at `pages.ts:229` says "~28").
- `include_descriptions=true` on the list tools (`src/tools/catalog.ts:53`) fans out the same way.

**Measured** with fetch stubbed and two identical `search_content("whatsapp", market "in")` calls, each on a fresh server as the HTTP transport does:

| | call 1 | call 2 |
|---|---|---|
| main @ d64497c | 28 outbound fetches | 28 |
| prototype of this plan (discarded, not pushed) | 12 | 0 |

**Not checked:** real-world latency, hit rate and memory under load against the live site (the sandbox egress blocks raivatedu.com).

## Proposed fix

1. **`src/services/website-client.ts`**
   - Add a small counting semaphore that caps simultaneous outbound requests (`maxConcurrentRequests`, default 4). Acquire it in `doRequest`, release it in `finally`.
   - Add a TTL page cache for successful `get()` results: a `Map` used as an LRU, `cacheTtlMs` default 10 min, `cacheMaxEntries` default 500. Errors and `head()` results (used by the status check) are never cached.
   - Add an in-flight map so concurrent `get()` calls for the same URL share one fetch.
   - Export `getSharedWebsiteClient(config, logger)`, a process-wide singleton, plus a test reset hook.
2. **`src/server.ts`**: `createServer(config, client?)`. If no client is passed, create one (stdio has one server anyway).
3. **`src/http.ts`**: in `runHttp`, build the shared client once and pass it to `createServer` for each request.
4. **Search fan-out (`src/tools/pages.ts`)**: replace the "all searchable pages" list with `selectSearchCandidates(pages, terms, max)`.
   - Pages whose path contains a query term go first (this needs no fetch).
   - The rest follow a fixed priority: home, pricing, product, the index pages, then detail pages and articles.
   - Cap the count at `searchMaxPages`.
5. **`src/config.ts`**: new env vars `RAIVATEDU_CACHE_TTL_MS` (0–3600000), `RAIVATEDU_CACHE_MAX_ENTRIES`, `RAIVATEDU_MAX_CONCURRENT_REQUESTS` (1–32) and `RAIVATEDU_SEARCH_MAX_PAGES`.
   - Unset means no cap on stdio and 12 pages on HTTP, where callers are anonymous.
   - Document all four in `.env.example`.
   - Update the search tool description so it no longer says "~28 pages".

## Tests to add (`tests/cache.test.ts`)

- A repeated GET makes 1 fetch.
- 3 concurrent GETs for the same URL make 1 fetch.
- An entry expires after the TTL (fake `Date`), and `cacheTtlMs: 0` turns caching off.
- A 404 is not cached.
- The LRU evicts the least recently used entry at `cacheMaxEntries`.
- The peak number of concurrent fetches equals `maxConcurrentRequests`.
- `getSharedWebsiteClient` returns the same instance.
- `httpConfig` lowers the search cap unless the env var is set.
- `selectSearchCandidates` puts `/in/features/attendance` first for the query "attendance" and respects the cap.
- An integration test: two HTTP-style searches make 12 and then 0 fetches.

## Risks / rollout

- Content can be up to 10 minutes stale after a site deploy. That is acceptable for marketing pages, and `RAIVATEDU_CACHE_TTL_MS=0` turns it off.
- Memory is bounded at roughly 500 pages of HTML (a few MB at most).
- The cache is per process. Several replicas each keep their own (fine at this scale).
- The 12-page HTTP search cap can miss matches on deep pages. Path-first ranking reduces this, and the operator can raise the cap.
- **Founder decision:** confirm the 10-minute TTL and the 12-page anonymous search cap.
- Overlaps `src/http.ts` and `website-client.ts` with the HTTP-hardening plan. Implement this one first.
