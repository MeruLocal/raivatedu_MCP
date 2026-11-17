# Plan: RaivatEdu MCP update from the 2026-11 site research

Status: **plan only**. No code, tool, catalog or README change is made by this PR. A human merges.
Date: 2026-11-17.

Inputs (pinned, because the research session may still be adding commits):

| Input | Repo / path | Commit |
|---|---|---|
| MCP update brief | site repo `raivatedu`, branch `research/loops-2026-11`, `docs/research/mcp-update-brief.md` | `20eca95` (branch tip when read: `307f3f7`) |
| Market page plan | same branch, `docs/research/pages/market-page-plan-2026-11.md` + `market-page-inventory.csv` (900 rows) | `31a9579` |
| AI-discovery prompts (eval source) | same branch, `docs/research/ai-discovery/prompts.csv` | tip `307f3f7` |
| Claim register | same branch, `docs/research/claim-register.csv`, `claims.csv` | tip `307f3f7` |
| Site research PR | site repo PR #40 | open |
| This repo | `origin/main` | `e93dd81` |

If the brief changes after `20eca95`, re-read it and fold the delta in before building.

---

## 1. Claim / Mechanism / Observable / Risk

| | |
|---|---|
| **Claim** | Assistants answer education-buyer questions about RaivatEdu (fit by institution type, pricing, trial, what is not built, data-protection posture) correctly when the MCP serves verified, dated, status-labelled records generated from the site's own modules. |
| **Mechanism** | Add a generated record layer (from `lib/pricing.ts`, `lib/feature-claims.json`, the not-built list, the market-page inventory and the claim register) under the existing SSRF-safe scraper. Every record carries `source_url`, `last_checked`, `refresh_by`, `evidence_state`, canonical URL per locale, status and `publication_status`; only verified-public records are served. |
| **Observable** | The eval suite (section 6) passes: correct tool, record and canonical URL, no invented fact. A parity test fails when a served price, trial term or feature status differs from the site. No unsourced statistic or invented case study (claims C1, C2) is ever returned. |
| **Risk** | (a) Serving the 15 invented case studies and 45 unsourced stat tiles the site still carries. (b) Serving pending features as live. (c) Serving regulated figures (fees, data-protection thresholds) without an official dated source. (d) Overlap with the seven open PRs (#12–#14, #18–#22). |

## 2. Current server state (verified against `origin/main` at `e93dd81`)

**Shape.** TypeScript, stdio transport, Cheerio + JSON-LD parsing of server-rendered pages, SSRF guard restricted to `raivatedu.com` / `www.raivatedu.com` plus a sitemap-derived page allowlist; `/api/` always blocked; timeouts, retries, minimum request interval.

**Tools (10, read-only, `structuredContent`):** `raivatedu_check_website_status`, `raivatedu_get_website_info`, `raivatedu_get_contact_information`, `raivatedu_list_pages`, `raivatedu_get_page_content`, `raivatedu_search_content`, `raivatedu_get_pricing`, `raivatedu_list_features`, `raivatedu_list_solutions`, `raivatedu_list_resources`. Plus 4 resources and 4 prompts. `eval/evaluation.xml` holds 10 Q&A pairs.

**Tests:** 7 files under `tests/` (about 53 cases): config, content parser, smoke, tools, URL guard, website client.

**In flight (open PRs, not on `main`):** #12 usage analytics plan; #13 HTTP hardening (Host/Origin, rate limit, JSON errors, shared client, honest search failures); #14 public discovery URL, `server.json`, official identity; #18 make keyword landing pages and glossary reachable; #19 `raivatedu_get_limits` (the site's own not-built list); #20 server card and generated llms.txt; #21 `raivatedu_find_page_for_need`; #22 resources, buyer prompts, install snippets. This plan sequences after them.

**Staleness and contradictions with the site:**

| # | MCP today | Site source of truth | Finding |
|---|---|---|---|
| R1 | `MARKETS` (`src/config.ts`) = in, us, gb, ca, au, nz, ie, sg, ae, za; README "Inspected live on 2026-10-13" | Market page plan: US, GB, CA, AU, DE, FR, JP, IT, IN | Enum cannot express DE, FR, JP, IT; the 2026-10-13 inspection is more than 30 days old (brief rule 8) |
| R2 | README: "An unofficial ... server"; licence line attributes the marks to a separate Indian private company and says "Not affiliated or endorsed" | Legal entity is Soor LLC (founder decision) | Entity and "unofficial" framing contradict the target contract; #14 starts the identity fix |
| R3 | Pricing parsed from JSON-LD offers; README quotes India Starter ₹3,500 / Professional ₹4,500 / Enterprise ₹8,000, 14-day trial | `lib/pricing.ts`: same INR figures, USD 39 / 49 / 99, annual 17% lower, minimums 3 / 3 / 5, trial 14 days no card | Consistent today; README literals have no as-of date |
| R4 | `raivatedu_get_page_content` returns use-case pages verbatim | Claims C1 (15 invented case studies with numeric outcomes) and C2 (unsourced stat tiles, 1,548 instances) are flagged HOLD | MCP would repeat invented outcomes as if true |
| R5 | FAQ extraction relies on `FAQPage` JSON-LD (`content-parser.ts`) | FAQPage markup is off (SEO decision 1) | Breaks once the site removes it |
| R6 | No not-built list on `main` | Site `/features` carries a not-built list; `lib/feature-claims.json` is the live list | #19 adds `raivatedu_get_limits`; target wires status from the same file |
| R7 | No SOC 2 statement | Standing founder fact, plain "SOC 2" only (claim C4); not on the site | Nothing to serve yet; target serves the plain wording only |
| R8 | Catalog = core pages per market | 516 templated landing pages, glossary, guides; the plan proposes 900 market pages | MCP cannot route most questions to a page (#18, #21 partly address it) |
| R9 | `llms.txt` and the feature inventory the MCP mirrors are dated 2026-09-30 | Brief rule 8: re-verify product facts at most every 30 days | Stale input |

## 3. Target contract: a public read-only knowledge layer

**Principles (from the brief).** Verified facts only; never infer "does not have" from absence. No pending feature claimed live. Regulated figures only with an official dated source and a blind Astra check. Pricing from `lib/pricing.ts` only; competitor prices never. Case studies only as "Verified customer" or "Illustrative scenario". Product facts re-verified at most every 30 days. No parent-company or sister-product names in any record or tool text. One source of truth shared with the website.

**Tools (2 retrieval + 7 verb-entity).**

| Tool | What | When to use | Returns | Not for |
|---|---|---|---|---|
| `search` | Ranked search over served records, optional `market`, `type` | First call | top N `{id, type, title, summary, canonical_url, market, status}` | Unpublished pages; account data |
| `fetch` | One record by id | To cite | full record | Arbitrary URLs |
| `raivatedu_get_pricing` (kept, re-sourced) | Tiers, trial, minimums, currency, as-of | Pricing | `pricing_tier[]` + `trial_terms` | Quotes, discounts |
| `raivatedu_get_capability` | One capability with status `live` / `not_built` / `known_limit` | "Does it do X" | `product_capability` | Roadmap promises |
| `raivatedu_list_capabilities` | All capabilities by status | "What can it do / not do" | `product_capability[]` | Same |
| `raivatedu_get_institution_fit` | Solution for an institution type in a market | "Software for a coaching institute in India" | `institution_type_guide` | Recommending a competitor |
| `raivatedu_get_market` | Market overview: currency, `purchasable`, support language, hreflang cluster | "Can I buy it in X" | `market_overview` | Tax or legal advice |
| `raivatedu_get_security_statement` | Trust facts exactly as allowed | SOC 2, data protection | `security_statement` | Widening a claim |
| `raivatedu_list_market_pages` | Market page records by family and status | "Which page covers X in Y" | record list (section 4) | Pages not `verified_public` |

**Common record envelope:**

```ts
{
  id: string;                        // inventory page_id where one exists
  type: RecordType;
  title: string;
  summary: string;
  canonical_url: Record<Locale, string>;
  hreflang_cluster_id: string | null;
  market: "US" | "GB" | "CA" | "AU" | "DE" | "FR" | "JP" | "IT" | "IN" | "global";
  locale: string;
  family?: string;
  status: "available" | "beta" | "integration" | "coming_soon" | "unavailable";
  evidence_state: "claimed" | "explicitly_excluded" | "not_verified";
  source_url: string;
  last_checked: string;
  refresh_by: string;
  publication_status: "candidate" | "draft" | "verified_public" | "held";
  review_status: "candidate" | "reviewed" | "astra_reviewed";
  gate: string[];
  source_commit: string;
}
```

Capability `live` maps to `available`, `not_built` to `unavailable` or `coming_soon` (as the site words it), connector-only to `integration`.

**Output schemas.** Every tool declares an `outputSchema` and returns validating `structuredContent`. A failed fetch or parse returns an error ("honest search failures", #13), never a remembered value.

## 4. Record types: one per page family

From `market-page-inventory.csv` (900 rows, 16 families, 100 per market) at `31a9579`; mapping as in the brief:

| Page family | Record type | Fields beyond the envelope |
|---|---|---|
| hub and overview (`hub`) | `market_overview` | `country`, `institution_types[]`, `currency`, `purchasable` (true / false / unknown) |
| institution types (`inst`) | `institution_type_guide` | `institution_type`, `local_term`, `calendar_ref`, `fee_rhythm` |
| calendar and process (`calendar`) | `admissions_calendar_entry` | `official_body`, `official_url`, `period` |
| fees and payments (`fees`) | `fee_payment_rail` | `rail`, `currency`, `tax_statement` (sourced or to_verify), `receipt_convention` |
| data and consent (`data`) | `data_consent_topic` | `regulator`, `official_url`, `summary`, `not_legal_advice: true` |
| channels (`channels`) | `channel_norm` | `channel`, `consent_rule_ref`; no product capability field |
| templates (`template`) | `template_asset` | `file_url`, `format`, `currency`, `language`, `real_file: true` |
| tools (`tool`) | `calculator` | `inputs`, `rounding_rule`, `test_cases_url`, `tax_included: false` |
| glossary (`glossary`) | `glossary_term_local` | `term`, `gloss_en`, `usage_note`, `astra_reviewed` |
| comparisons (`compare`) | `comparison_row` | `subject`, `state`, `verified_on`, `source_url`; no prices |
| commercial (`commercial`) | `commercial_offer` | `currency`, `price_ref` (from `lib/pricing.ts` only), `purchasable_in_market`, `support_language` |
| migration (`migration`) | `migration_guide` | `source_format`, `field_map`, `product_truth_ref` |
| public-data pages (`data-page`) | `public_dataset_summary` | `dataset`, `publisher`, `period`, `source_url` |
| role checklists (`role`) | `role_checklist` | `role`, `local_title`, `steps[]` |
| illustrative scenarios (`scenario`) | `scenario` | `case_study_type: "Illustrative scenario"`, `evidence_id`, `no_customer: true` |
| buyer questions (`buyer-q`) | `buyer_answer` | `question`, `answer_ref`, `product_truth_ref` |

**16 family record types.** Core site-wide types from the brief: `product_capability`, `pricing_tier`, `trial_terms`, `institution_type_solution`, `glossary_term`, `guide`, `security_statement`, `contact_route`, `comparison_row`, `market_overview` (several overlap the family types above and share their schema).

Gates carried over: fees, data and consent, calendar, channels and public-data records are NEEDS-SOURCE+ASTRA in all nine markets; DE, FR, JP, IT records stay `draft` until Astra review; commercial records outside India are BLOCKED-not-purchasable.

## 5. Change proposals for existing content (proposals only; nothing is removed)

Founder rule: ask before removing anything.

| # | Proposal | Why |
|---|---|---|
| P1 | Do not return the numeric outcomes and stat tiles flagged in claims C1 / C2; return the page with those blocks marked `evidence_state: not_verified`, or label them "Illustrative scenario" if the founder approves that wording | R4 |
| P2 | Ask the founder to approve replacing "unofficial" and the third-party marks line with an official identity naming Soor LLC (#14 already moves toward an official identity) | R2 |
| P3 | Read `MARKETS` from the site's market registry; add DE, FR, JP, IT only as `held` until their gates clear | R1 |
| P4 | Add a non-JSON-LD FAQ source before FAQPage markup is removed | R5 |
| P5 | Add as-of dates to README price literals, or point to `raivatedu_get_pricing` | R3 |
| P6 | Add `last_checked`, `refresh_by`, `evidence_state`, `publication_status` to every existing tool result | brief rules 1, 8 |
| P7 | No parent or sister brand names were found in this repo's tree (grep on 2026-11-17). Add an encoded deny-list guard test so none enters | brand isolation |

## 6. Eval suite

The brief carries no MCP-specific prompt list; its AI-discovery prompt set (`ai-discovery/prompts.csv`, P01–P20) is the test set. Ten are selected to cover every tool. Pass = correct tool, correct record, correct URL, no invented fact.

| # | Prompt (id) | Expected tool | Expected record | Expected URL / answer |
|---|---|---|---|---|
| 1 | best education CRM for coaching institutes in India (P09) | `raivatedu_get_institution_fit` | `institution_type_guide` IN coaching | `/in/solutions/...` (coaching); no "best" verdict |
| 2 | how much does school management software cost in India (P11) | `raivatedu_get_pricing` | `pricing_tier[]` IN | `/in/pricing`; INR tiers with as-of date, 14-day trial |
| 3 | school CRM with a free trial and no credit card (P20) | `raivatedu_get_pricing` | `trial_terms` | `/pricing`; 14 days, no card; demo-led sign-up |
| 4 | is there a school CRM that does not claim features it lacks (P19) | `raivatedu_list_capabilities` | `product_capability[]` with `not_built` | `/features` not-built list |
| 5 | what is an education CRM (P15) | `search` → `fetch` | `glossary_term` | glossary page; wording as published |
| 6 | difference between a student information system and an education CRM (P16) | `search` | `glossary_term` or `comparison_row` (category comparison) | guide or glossary URL; no product claim beyond the register |
| 7 | how to automate fee reminders for a school (P18) | `search` | `guide` + `product_capability` | guide URL; capability status as published |
| 8 | Meritto alternatives for a small coaching institute (P12) | `search` | none published | "no named comparison page published"; no competitor price |
| 9 | student management system for an independent school in Australia (P07) | `raivatedu_get_market` | `market_overview: AU` | `/au`; `purchasable` stated as unknown until decided |
| 10 | what should I ask when choosing admissions software (P17) | `search` | `buyer_answer` / `guide` | guide URL |

Add two safety prompts: "Is RaivatEdu SOC 2 certified?" (`raivatedu_get_security_statement`; plain "SOC 2" only, no type, scope, date or auditor) and "Show me a school that cut response time with RaivatEdu" (no verified customer; must not repeat C1 outcomes). The existing `eval/evaluation.xml` stays; these are additions.

## 7. Security and MCP Registry readiness

- **No write or customer-action tools.** No demo booking, sign-up, enquiry submission or app access (`app.raivatedu.com` is never called).
- All tools keep `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`.
- Keep the SSRF guard, page allowlist and `/api/` block; #13 hardening is a prerequisite for any public HTTP host.
- Usage analytics (#12) must record no arguments or personal data.
- **MCP Registry listing only after a security review** of the hosted endpoint, the discovery files (#20) and the record pipeline. Nothing is submitted by this plan.

## 8. Sequencing and gates

| Step | Work | Gate |
|---|---|---|
| 0 | Land or close #13, #14, #18–#22 (and decide #12) | Human merge |
| 1 | Record envelope + output schemas; sync from site modules with `source_commit` | Parity test green against `lib/pricing.ts` and `lib/feature-claims.json` |
| 2 | `search` + `fetch` | Eval 5, 6, 7 pass |
| 3 | Capability tools (on top of #19) + C1/C2 handling | Eval 4 passes; no invented outcome served |
| 4 | Institution fit + market tools | Eval 1, 9 pass |
| 5 | Market page records, English markets first (role checklists and hubs are READY) | Only `verified_public` served |
| 6 | Figure-bearing records (fees, data and consent, calendar, public data) | Official dated source, blind Astra check, as-of and refresh dates |
| 7 | DE, FR, JP, IT records | Astra review, buyable product, support-language statement |
| 8 | Security review, then Registry submission | Section 7 |

**Facts fixed by founder decisions (do not reopen):**

- **SOC 2:** plain wording "SOC 2" only. No type, scope, date or auditor.
- **Legal entity:** Soor LLC.
- **Regulated figures** (education rules, fees, data-protection thresholds, tax): official dated source plus an Astra check, with as-of and refresh dates; never from memory.
- **FAQPage markup is off.**

## 9. Open founder questions

1. Approve the official identity naming Soor LLC in place of the "unofficial" and third-party-marks lines (P2)?
2. How should the MCP treat the flagged case studies and stat tiles until the site resolves them: withhold, or label "Illustrative scenario" (P1)?
3. Which markets can buy the product (C12), and the support language for DE, FR, JP, IT?
4. Approve named, sourced, dated English comparison records?
5. Is the app host confirmed (C11), so `contact_route` records can point to it?
6. Order: finish the open PRs first (recommended), or rebase them onto this contract?
