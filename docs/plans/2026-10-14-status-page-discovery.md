# Plan: rewrite the HTTP status page and make discovery advertise the public /mcp URL

- **Severity:** P1 (agents and registries read these surfaces verbatim; today they describe tools that do not exist and point at localhost)
- **Effort:** S
- **Status:** Plan only. Implementation follows after approval.

## Finding

`src/http.ts` on main @ d64497c:

- **`statusPage()` (`:31-81`) was copied from another server:**
  - It says the mirror covers "comparisons" (`:59`, `:71`), but no comparison tool or page type exists.
  - It mentions "Content-management tools and the tools that read newsletter subscribers or contact-form submissions" (`:76-78`). None of those exist here.
  - The opening paragraph is duplicated almost word for word (`:57-60` and `:70-74`), as is the status-links line (`:62-64` and `:80`).
  - The `/sse` wording was removed in d64497c, so that part of the original finding is already fixed on main.
- **`discoveryDoc(port)` (`:85-99`)** advertises `endpoint: http://localhost:${port}/mcp`. In production, `/.well-known/mcp.json` therefore tells clients and registries to connect to localhost.
- **CORS:** the audit script reports `WARN discovery: manifest lacks Access-Control-Allow-Origin: *` (measured on a local build of main).
- **Re-audit 2026-10-14** (new `audit-live-mcp.mjs`, same build): the localhost endpoint is now a hard **`FAIL X.discovery_url`** ("discovery doc advertises a dev host: http://localhost:3917/mcp"), plus `WARN C16.cors` for the missing `Access-Control-Allow-Origin: *`. This plan clears both. The status page also links `/version` twice and `/health` once; after the rewrite each appears once.

**Not checked:** what `https://mcp.raivatedu.com/.well-known/mcp.json` serves today (unreachable from the sandbox).

## Proposed fix (`src/http.ts` only)

1. Add `publicBaseUrl(env)`. It reads `PUBLIC_BASE_URL` (http/https only, trailing slash stripped) and falls back to `https://mcp.raivatedu.com`. Document it in `.env.example`, for example `PUBLIC_BASE_URL=http://localhost:3000` for local use.
2. **`discoveryDoc(baseUrl)`:**
   - `transport.endpoint = ${baseUrl}/mcp`
   - a description that matches the real tools: pricing, features, solutions, resources, contact details, page content and search
   - set `Access-Control-Allow-Origin: *` on this route only (public metadata, no credentials)
   - no hand-listed tool names: `tools/list` owns those, and the audit FAILs any manifest that duplicates them
3. **`statusPage(baseUrl)`:** one page, with no duplicated paragraphs.
   - It says what the server is: read-only access to the public RaivatEdu (admissions/education CRM) website.
   - It gives the endpoint `${baseUrl}/mcp` (POST, no key).
   - It describes the capabilities that exist: plans and prices per market as published, features, solutions (schools, colleges, coaching, training), resource articles, contact and demo links, page text, site search and a reachability check.
   - It has a privacy line: no student, enquiry or customer data, never send credentials.
   - It links `/health`, `/version` and `/.well-known/mcp.json`.
   - Escape the base URL before inserting it into the HTML.
4. Export `statusPage` and `discoveryDoc` so they can be tested.

## Tests to add (`tests/http-landing.test.ts`)

- `discoveryDoc("https://mcp.raivatedu.com").transport.endpoint === "https://mcp.raivatedu.com/mcp"`. Also test a custom `PUBLIC_BASE_URL`, and that an invalid one falls back to the default.
- The status page does not contain `newsletter`, `contact-form`, `comparisons` or `/sse`, contains `/mcp`, and contains the opening sentence exactly once.
- The discovery route sets `Access-Control-Allow-Origin: *` (express app on port 0).
- The manifest JSON has no `tools` array.
- Re-run `audit-live-mcp.mjs` and expect the CORS WARN to clear.

## Risks / rollout

- Production must either leave `PUBLIC_BASE_URL` unset (default `https://mcp.raivatedu.com`) or set it correctly. A wrong value would misdirect clients.
- **Founder decision:** confirm `https://mcp.raivatedu.com` is the public host, and the one-line product description ("admissions and education CRM").
- Overlaps `src/http.ts` with the cache and hardening plans (different functions). Small rebase only.
