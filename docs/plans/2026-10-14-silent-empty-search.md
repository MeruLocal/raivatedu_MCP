# Plan: report an error, not "no matches", when the site cannot be fetched

- **Severity:** P1 (a false fact: an agent tells the user "RaivatEdu doesn't cover X" when the site was simply unreachable)
- **Effort:** S
- **Status:** Plan only. Implementation follows after approval.
- **Audit check:** skill §4 C4 (silent zero) · MCP Center C10

## Finding

Both fan-out paths swallow every fetch error and carry on as if the page had no content:

- `src/tools/pages.ts:267-276` (`raivatedu_search_content`): each candidate fetch is wrapped in `try { … } catch { return null; }` ("search is best-effort"). Failed pages are dropped, then the tool returns a normal, non-error result.
- `src/tools/catalog.ts:53-61` (`enrich`, used by `list_features`, `list_solutions`, `list_resources` with `include_descriptions: true`): `catch { return { ...e, description: undefined }; }`. The caller asked for descriptions and gets none, with no hint why.

**Measured** on a local build of main @ d64497c (`node dist/index.js --http`), where the sandbox has no egress to raivatedu.com, so every fetch fails:

```
tools/call raivatedu_search_content {"query":"attendance","response_format":"json"}
→ {"query":"attendance","market":"in","pages_searched":0,"count":0,"results":[]}   (no isError)
```

The markdown variant says "Searched 0 pages; 0 match(es). No matching pages. Try broader or different keywords". So when the origin is down, rate-limits us, or blocks the server's IP, the answer reads as "the site never mentions attendance", although `/in/features/attendance` exists.

`list_features {"include_descriptions":true}` in the same run returned the 9 labels and URLs with no descriptions and no warning.

The other tools are fine: a single-page fetch failure becomes an `isError` result via `toToolError` (measured: `check_website_status` and `get_page_content` both return `isError: true`, "Network error: fetch failed … This looks transient").

**Not checked:** behaviour against the live site with partial failures (needs egress).

## Proposed fix

1. **`src/tools/pages.ts` search handler:** count failures alongside results.
   - `pages_failed` (number) and `pages_searched` (successful fetches) both go into `structuredContent`.
   - If **every** fetch failed (`pages_searched === 0 && candidates.length > 0`), return `toToolError` with the first `WebsiteClientError` ("Could not reach raivatedu.com to search; nothing was searched. Retry shortly or call raivatedu_check_website_status."). Never return "no matches" in that case.
   - If **some** failed, return the results and add a line: "Note: N of M pages could not be fetched; results may be incomplete." Markdown and structured output both carry it.
2. **`src/tools/catalog.ts` `enrich`:** keep the per-item fallback, but return `descriptions_unavailable: number` in the structured result and a one-line note in markdown when it is above 0. If all fetches failed, say so explicitly ("descriptions could not be fetched; labels and URLs are from the verified catalog").
3. Keep the catch blocks narrow: catch `WebsiteClientError` only, so a parser bug surfaces as an error instead of an empty page.
4. Description of `search_content`: add "Returns an error if the site cannot be reached".

This plan only changes error reporting. The cache plan (PR #2) changes which pages are searched; the two merge independently, and #2's candidate cap does not affect the "all failed" rule.

## Tests to add (`tests/tools.test.ts`, mocked fetch)

- All fetches reject → `search_content` returns `isError: true` and the text does not contain "No matching pages".
- 3 of N fetches return 503 → result has `pages_failed: 3`, results from the rest, and the "may be incomplete" note.
- All fetches succeed → no note, `pages_failed: 0` (existing happy path unchanged).
- `list_features` with `include_descriptions: true` and all fetches failing → `descriptions_unavailable: 9` and the note.
- A parser exception is not swallowed (surfaces as `isError`).

## Risks / founder decisions

- Agents that today get an empty list will now get an error while the site is down. That is the intended behaviour.
- `structuredContent` gains two optional fields; if the outputSchema plan (PR #6) lands first, add them to its schemas.
- No founder decision needed.
