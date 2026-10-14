# Plan: harden the public HTTP endpoint (Host/Origin allowlist, rate limit, body cap, checked redirects)

- **Severity:** P0 (cross-origin browser access and unchecked off-domain redirects on a public endpoint)
- **Effort:** M
- **Status:** Plan only. Implementation follows after approval.

## Finding

Measured against a local `node dist/index.js --http` build of main @ d64497c:

| Check | Result on main |
|---|---|
| `POST /mcp` with `Origin: http://evil.example` | **200**, accepted |
| Host validation / DNS-rebinding protection | none: `src/http.ts:129` builds the transport without `allowedHosts`, `allowedOrigins` or validation middleware |
| Rate limit | none on `/mcp` |
| Body cap | `express.json({ limit: "1mb" })` exists (`src/http.ts:107`), but oversized or malformed bodies fall through to Express's default **HTML** error handler, not a JSON-RPC error |
| Error body leak (re-audit 2026-10-14) | with `NODE_ENV` unset, a 1.2 MB body and `{bad` both return Express's HTML error page **with the stack trace and absolute `node_modules` paths of the deploy directory**. The Dockerfile sets `NODE_ENV=production`, which hides the stack; a plain `node dist/index.js --http` deploy does not. The audit script's `X.body_cap` PASSes on the 413 status alone, so it does not catch this |
| Outbound response size (re-audit 2026-10-14) | `website-client.ts:158` reads `await res.text()` with no length or content-type guard, so one tool call buffers whatever the origin (or a redirect target) sends |
| Redirects | `src/services/website-client.ts:85` uses `redirect: "follow"` and checks the host only **after** the chain completes (`:97`), so an off-domain hop is already fetched before it is rejected |

`README.md:343` claims "redirects are re-validated against the allowlist". That is only true after the fact.

**Re-audit 2026-10-14** (new `audit-live-mcp.mjs`, local build of main @ d64497c): `FAIL X.rebinding` for both a foreign Origin and a foreign Host, `WARN X.rate_limit` (no 429 in 70 requests). This plan clears all three.

**Not checked:** how production is started (Docker with `NODE_ENV=production` or not), the production proxy setup (Cloudflare and Apache headers), and the live site's redirect behaviour.

## Proposed fix

1. **New `src/http-security.ts`**, mounted on `/mcp` only, so `/health`, `/` and the discovery doc stay open for probes:
   - **Host check:** the SDK's `hostHeaderValidation(allowedHosts)` middleware (`@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js`). It is port-agnostic. The transport's own `allowedHosts` and `enableDnsRebindingProtection` options are deprecated in SDK 1.32 in favour of this middleware.
   - **Origin check:** requests with no `Origin` header (CLI and server-side clients) pass. Allowed origins and `http(s)://localhost|127.0.0.1|[::1]:*` pass. Everything else gets 403 with a JSON-RPC error.
   - **Per-IP rate limit:** a fixed one-minute window, 60 requests a minute by default. The key is `req.socket.remoteAddress`, or the right-most `X-Forwarded-For` hop only when `TRUST_PROXY=1`. Over the limit it returns 429 with `Retry-After`. The table is pruned when it passes 10k keys.
   - **JSON error handler** (registered last): `entity.too.large` gives a JSON 413, `entity.parse.failed` a JSON-RPC parse error (400), and anything else a generic 500 "Internal server error" with no stack trace.
2. **Env vars** (document in `.env.example`):
   - `MCP_ALLOWED_HOSTS`, default `localhost,127.0.0.1,[::1],mcp.raivatedu.com`
   - `MCP_ALLOWED_ORIGINS`, default `https://mcp.raivatedu.com,https://raivatedu.com,https://www.raivatedu.com`
   - `MCP_RATE_LIMIT_PER_MIN`, default 60; 0 turns the limit off
   - `TRUST_PROXY`
3. **`src/http.ts`**: `app.disable("x-powered-by")`. Mount the three middlewares on `/mcp` before `express.json`, and the error handler after the routes.
4. **`src/services/website-client.ts` `doRequest`**: switch to `redirect: "manual"` and loop at most 5 hops. Before following each `Location`, resolve it against the current URL and require:
   - HTTPS
   - a host in `ALLOWED_HOSTS`
   - a path that is not `/api` or `/api/...`

   Otherwise throw a `WebsiteClientError` without fetching the target. Cancel the body of each 3xx response.
5. **Outbound response cap (added by re-audit 2026-10-14):** in `get()`, reject a `Content-Length` above `RAIVATEDU_MAX_RESPONSE_BYTES` (default 2 MB) before reading, and read the body as a stream that aborts past the same limit (servers can omit or lie about the header). Accept only `text/html`, `application/xhtml+xml` and `*/xml` content types. Both throw a non-retryable `WebsiteClientError`.
6. Correct the README security section to match.

## Tests to add (`tests/http-security.test.ts`, with a throwaway express app and `fetch`)

- A foreign Origin gets 403. No Origin, an allowed origin and `http://localhost:6274` get 200.
- A Host that is not on the list gets 403.
- With a limit of 3 per minute, a 4th request gets 429 with `Retry-After`.
- With `TRUST_PROXY=1`, a spoofed left-most XFF hop does not get a fresh bucket.
- A 1.1 MB body gets a JSON 413. A thrown error gets a generic 500 that does not contain the internal message.
- The 413 and 400 bodies contain no `at `, `node_modules` or absolute path, with `NODE_ENV` unset (re-audit 2026-10-14).
- A 3 MB response, and a response with no `Content-Length` that streams past 2 MB, both throw without buffering it all; an `image/png` response is refused.
- Redirects:
  - an off-domain target makes exactly 1 fetch and throws, with `redirect: "manual"` asserted
  - `http://` and `/api/` targets are refused
  - an on-domain redirect is followed
  - the client stops after 5 hops

A discarded prototype passed all of these. On a local build, curl showed: evil Origin 403, evil Host 403, no Origin 200, 1.2 MB 413, `{bad` 400, and 429 after 60 requests.

## Risks / rollout

- **Behind Cloudflare/Apache, set `TRUST_PROXY=1`.** Otherwise every caller shares one bucket (the proxy's IP). Make sure the proxy forwards `Host: mcp.raivatedu.com`, or add the upstream host to `MCP_ALLOWED_HOSTS`.
- The rate limit is per process (in memory). Use the proxy or WAF for cross-replica limits.
- Browser-based MCP clients hosted on other origins will be refused until they are added to `MCP_ALLOWED_ORIGINS`.
- **Founder decision:** 60 requests a minute per IP, and the allowed-origin list.
- Touches the same files as the cache plan. Implement after it.
