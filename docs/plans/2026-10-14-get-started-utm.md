# Plan: add raivatedu_get_started, UTM-tag own-site URLs, and source trial/currency text from JSON-LD

- **Severity:** P1 (conversion: the MCP answers questions but never hands the agent a tracked next step)
- **Effort:** M
- **Status:** Plan only. Implementation follows after approval. **No price, amount or plan value changes.**

## Finding

- **No "get started" tool.** An agent asked "how do I try RaivatEdu?" has to chain `get_contact_information` and `get_pricing`.
- **No attribution.** No tool tags its URLs, so MCP-referred traffic is invisible in analytics. URLs are built bare in `src/tools/website.ts`, `pages.ts`, `pricing.ts`, `catalog.ts` and `src/resources/index.ts`.
- **Hard-coded commercial claims** that do not come from the page:
  - `src/tools/pricing.ts:93-96`: "All plans include a 14-day free trial (no credit card required)", appended to every pricing answer
  - `src/tools/pricing.ts:25`: the same claim in the tool description
  - `src/prompts/index.ts:58`: "Mention the 14-day free trial"
- **Currency** in the pricing result (`src/tools/pricing.ts:60`) comes from the static `MARKET_INFO[m].currency` map, not from the offers' `priceCurrency` that the parser already extracts.

**Not checked:** whether the live pricing JSON-LD carries trial terms (for example an Offer `description`, `eligibleDuration`, or an FAQ "free trial" entry). The site is unreachable from the sandbox. The plan must work either way.

## Proposed fix

1. **`src/utils/utm.ts`:** `withUtm(url, tool)`.
   - Only for hosts in `ALLOWED_HOSTS`.
   - Appends `utm_source=mcp&utm_medium=ai_agent&utm_campaign=<tool_name>`.
   - Preserves any existing query string and `#fragment`, and never overwrites a UTM key that is already set.
   - External URLs are returned unchanged.
2. **Apply it to every own-site URL a tool or resource returns,** in both the structured and the markdown output.
   - `resolveToSafeUrl` already strips `?query`, so tagged URLs can still be passed back to `get_page_content`. A test asserts this.
   - `source_url` fields stay untagged: they are citations, not links for people to click. **Founder decision:** tag those too?
3. **New tool `raivatedu_get_started`** (read-only, `openWorldHint: false`, no network). Input is `market?`. It returns:
   - `{ market, demo_url, contact_url, pricing_url, signup_url: null, note, call_to_action }`
   - the URLs `/{m}/demo`, `/{m}/contact` and `/{m}/pricing`, all from the existing catalog and UTM-tagged with `utm_campaign=raivatedu_get_started`
   - `signup_url: null` with a note: "No self-serve signup page is published in the sitemap; use the demo or contact page." No paths are invented.
   - one CTA line: "Book a demo or contact sales to start a trial."
4. **Trial and currency text from JSON-LD (`content-parser.ts` + `pricing.ts`):**
   - Add `extractTrialTerms(jsonLd)`, which reads, in order:
     - an Offer or `PriceSpecification` `eligibleDuration` / `description` mentioning a trial
     - a FAQPage answer matching `/free trial/i`
   - Return `{ text, source: "json-ld" | "faq" } | null`.
   - The pricing footer uses that text with its source. If nothing is found, it says "Trial terms: see the pricing page" plus the URL. It no longer asserts 14 days.
   - Remove the hard-coded claim from the tool description and the prompt. The prompt says "mention any free-trial terms that `get_pricing` reports".
   - **Currency:** use the single `priceCurrency` shared by all offers. Fall back to `MARKET_INFO` when there are no offers or they disagree. Amounts are untouched.
5. Add the tool to the README tool reference and to the tool-count assertion in `tests/tools.test.ts` (10 → 11).

## Tests to add

- `utm.test.ts`:
  - an own-site URL gets tagged
  - an existing query is kept, and so is a `#hash`
  - an existing `utm_source` is not overwritten
  - an external URL is untouched
- `get_started`: returns demo, contact and pricing URLs for the market, with UTM and `signup_url === null`.
- `get_page_content` accepts a UTM-tagged URL.
- The pricing footer with fixture JSON-LD (FAQ "14 days") contains that FAQ text. Without trial data it does not contain "14-day".
- Currency comes from `priceCurrency`, with the map as fallback.
- Prices in the fixture are unchanged (3500 / 4500 / 8000).

## Risks / founder decisions

- **Founder decision:** is the 14-day / no-card trial a firm policy that should stay asserted even when the page markup doesn't say it? If yes, the site's JSON-LD should publish it, and this plan reads it from there.
- **Founder decision:** is there a real self-serve signup URL? Today none is known, so it returns `null`.
- UTM-tagged links make the markdown a little longer. Negligible.
