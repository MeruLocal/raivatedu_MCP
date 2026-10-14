# Plan: server.json for the MCP registry, single-source version, clarify /version vs /health

- **Severity:** P2 (distribution and metadata hygiene)
- **Effort:** S
- **Status:** Plan only. Implementation follows after approval.

## Finding

- There is no `server.json`, so the server cannot be published to the official MCP registry.
- The version is hard-coded twice: `src/config.ts:163` (`SERVER_VERSION = "1.0.0"`) and `package.json` (`"version": "1.0.0"`). The User-Agent, `/version`, `/health`, the discovery doc and `--version` all read the constant, so a `package.json` bump silently leaves them stale.
- `/health` and `/version` (`src/http.ts:109-115`) return almost the same JSON.
- Audit script, first run (old script, local build of main @ d64497c): **2 fail · 5 warn · 13 pass**, including `FAIL tools: /version says undefined tools, tools/list returns 10` and `WARN version: /version does not advertise mcp_endpoint`. The other FAIL there (`no mcp-session-id header on initialize`) was HelloGrowthCRM-specific; this server is stateless by design.
- **Re-audit 2026-10-14** with the new `audit-live-mcp.mjs` (same build): the tool-count FAIL is gone, because the new script only compares counts when `/version` publishes one. What remains for this plan is `WARN X.version /version does not advertise the MCP endpoint path`. Publishing live counts (step 3) stays worthwhile, because the new script then cross-checks them (`C15.tool_count`).
- The npm package `raivat-education-mcp-server` is not published: `https://registry.npmjs.org/raivat-education-mcp-server` returns **404** (measured 2026-10-14).
- The SDK range in `package.json` is `^1.12.0` while the lockfile resolves `1.32.1`. Anyone installing the package into a tree that already holds an older 1.x (1.12 or later) can satisfy the range with it, and older 1.x releases lack APIs the other plans rely on (the host-validation middleware, `Implementation.websiteUrl`/`icons`). (Added by re-audit 2026-10-14.)

## Proposed fix

1. **`server.json`** at the repo root:
   - schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
   - shaped like `HelloGrowthCRMwebsite_MCP/server.json`
   - `name: io.github.merulocal/raivatedu-mcp`, a description, `websiteUrl: https://www.raivatedu.com`, repository `https://github.com/MeruLocal/raivatedu_MCP`, `version` = package.json version
   - `remotes: [{ type: "streamable-http", url: "https://mcp.raivatedu.com/mcp" }]`
   - **No** `packages` entry until the npm package is published (a `packages` entry for an unpublished package fails registry validation)
2. **Version from package.json at runtime:**
   - In `src/config.ts`, read `../package.json` relative to `import.meta.url` with `readFileSync` + `JSON.parse`, guarded by try/catch, with fallback `"0.0.0"`.
   - Do not use a JSON import attribute, so the tsconfig stays as it is.
   - The Dockerfile already copies `package.json` into the runtime image (verify while implementing).
3. **`/version` vs `/health`:** keep both and document them.
   - `/health` is liveness only: `{status:"ok"}`.
   - `/version` is metadata: `{name, version, tools, resources, prompts, mcp_endpoint}`. The counts come live from the registered server (build one server at startup and count its registrations), not hard-coded, which clears the `X.version` WARN above.
4. **SDK range:** raise `@modelcontextprotocol/sdk` to `^1.32.1` (matching the lockfile; no runtime change).
5. **`scripts/check-versions.mjs`**: package.json and server.json versions must match. Wire it into the CI plan as `npm run check:versions`.

## Tests to add

- `SERVER_VERSION === require(package.json).version`.
- `server.json` parses, the version matches, and it has a `remotes[0].url` ending in `/mcp`.
- `/version` reports `tools === (await client.listTools()).tools.length` and `mcp_endpoint` ends in `/mcp`.
- Audit re-run: the `/version` FAIL and WARN clear.

## Risks / founder decisions

- **Founder decision:** the registry namespace (`io.github.merulocal/...` versus a DNS-verified `com.raivatedu/...`, which needs a DNS TXT record), and whether to publish to npm.
- `mcp_endpoint` depends on `PUBLIC_BASE_URL` from the status-page plan. Implement after that plan.
