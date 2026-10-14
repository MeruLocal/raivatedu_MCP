# Plan: declare outputSchema on all 10 tools and drop the duplicate JSON text mode

- **Severity:** P2 (client ergonomics and token cost)
- **Effort:** M
- **Status:** Plan only. Implementation follows after approval.

## Finding

- All 10 tools already return `structuredContent` (`src/tools/shared.ts:46-62`), but none declares `outputSchema`. The audit script on a local build of main reports: `WARN tools: no tool sets outputSchema — every result must be re-parsed from text by the model`.
- Each tool documents its JSON shape only in prose in the description, for example `src/tools/pricing.ts:32-40` and `src/tools/pages.ts:113-122`. That prose costs tokens on every `tools/list` and can drift from the code.
- `response_format: "json"` (`shared.ts:12-18`, `:50-51`) serialises the same object that is already in `structuredContent` into `content[0].text`. With JSON selected the client receives it twice. With markdown selected, structured clients get it anyway.
- No `websiteUrl` or `icons` on the server info (`src/server.ts:24`). SDK 1.32's `Implementation` type supports both.

**Not checked:** how specific MCP clients (Claude Desktop, Cursor) render `outputSchema`.

## Proposed fix

1. **New `src/tools/schemas.ts`** with zod raw shapes per tool, mirroring the objects each handler builds today:
   - `pricingOutput`: market, currency, plans[{plan, billing, price, currency, unit, minUsers?, maxUsers?, url?}], source_url
   - `listPagesOutput`, `pageContentOutput`, `searchOutput`
   - `websiteInfoOutput`, `contactOutput`, `statusOutput`
   - `featuresOutput`, `solutionsOutput`, `resourcesOutput`

   Optional fields stay optional. Use `.passthrough()` where future fields are likely.
2. Pass `outputSchema` in each `registerTool` call (`website.ts`, `pages.ts`, `pricing.ts`, `catalog.ts`). The SDK validates `structuredContent` against it; error results (`isError`) are exempt.
3. **`response_format`:**
   - Keep accepting it so existing callers don't break (zod strips unknown keys anyway).
   - Mark it deprecated in its description.
   - Make `content[0].text` always the markdown rendering; the JSON lives in `structuredContent`.
   - Delete the "Returns JSON shape:" prose from descriptions, since the schema replaces it.
   - **Alternative:** keep `json` mode unchanged and only add schemas. Founder's choice.
4. **`src/server.ts`:** add `websiteUrl: "https://www.raivatedu.com"` to the server info. Add `icons` **only** if the founder supplies a stable public icon URL. The Organization JSON-LD logo (`/brand/logo.png` in the test fixture) is unverified live.

## Tests to add

- `tests/tools.test.ts`:
  - every tool in `listTools()` has `outputSchema.type === "object"`
  - each happy-path call's `structuredContent` passes the client-side validation (the SDK `Client` validates automatically when `outputSchema` is present, so the existing calls cover it)
  - add one negative test with a handler fixture returning a bad shape
- `initialize` returns `serverInfo.websiteUrl`.
- Audit re-run: the outputSchema WARN clears.

## Risks / rollout

- A schema that is stricter than real live data (for example a missing `unit` on a live offer) turns a working call into a validation error. Mitigation: mark every JSON-LD-derived field optional or nullable, and run the `RUN_SMOKE=1` live tests before merging. That needs network to raivatedu.com, which the sandbox doesn't have.
- Removing `json` text mode changes output for callers who parse `text`. **Founder decision:** remove it or keep it.
