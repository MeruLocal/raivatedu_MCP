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
| Redirects | `src/services/website-client.ts:85` uses `redirect: "follow"` and checks the host only **after** the chain completes (`:97`), so an off-domain hop is already fetched before it is rejected |

`README.md:343` claims "redirects are re-validated against the allowlist". That is only true after the fact.

**Not checked:** the production proxy setup (Cloudflare and Apache headers), and the live site's redirect behaviour.

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
5. Correct the README security section to match.

## Tests to add (`tests/http-security.test.ts`, with a throwaway express app and `fetch`)

- A foreign Origin gets 403. No Origin, an allowed origin and `http://localhost:6274` get 200.
- A Host that is not on the list gets 403.
- With a limit of 3 per minute, a 4th request gets 429 with `Retry-After`.
- With `TRUST_PROXY=1`, a spoofed left-most XFF hop does not get a fresh bucket.
- A 1.1 MB body gets a JSON 413. A thrown error gets a generic 500 that does not contain the internal message.
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
