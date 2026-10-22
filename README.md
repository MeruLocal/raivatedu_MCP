# RaivatEdu Education MCP Server

The official, read-only [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for RaivatEdu. It lets Claude Desktop (or any MCP client) explore the **public** RaivatEdu website — [raivatedu.com](https://www.raivatedu.com) — using natural language.

RaivatEdu is **admissions & student-relationship software** (a SaaS marketing site), **not** a course catalog. This server reflects what the site actually publishes: product/feature information, pricing by market, solutions by audience, resource articles, and contact details. It fetches only public marketing pages, honours `robots.txt`, and never touches private/authenticated areas.

---

## Table of contents

- [Verified website capability analysis](#verified-website-capability-analysis)
- [What this server exposes](#what-this-server-exposes)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation, build & run](#installation-build--run)
- [Run over HTTP / Docker](#run-over-http--docker)
- [Claude Desktop integration](#claude-desktop-integration)
- [MCP tool reference](#mcp-tool-reference)
- [Resources & prompts](#resources--prompts)
- [Environment variables](#environment-variables)
- [Testing](#testing)
- [Example conversations](#example-conversations)
- [End-to-end verification checklist](#end-to-end-verification-checklist)
- [Security considerations](#security-considerations)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Verified website capability analysis

Inspected live on **2026-10-13** via `robots.txt`, `/sitemap.xml` (+ its three child sitemaps), raw HTML, and embedded JSON-LD.

| Area | Finding | Verified? |
| --- | --- | --- |
| Purpose | Marketing site for RaivatEdu admissions/CRM software for schools, colleges, coaching & training | ✅ |
| Rendering | Next.js, **server-side prerendered** (`x-nextjs-prerender: 1`) — full content in raw HTML | ✅ (Cheerio is enough; no headless browser needed) |
| Structured data | Rich schema.org **JSON-LD** on every page: `Organization`, `WebSite`, `WebPage`, `SoftwareApplication` with pricing `Offer`s, and `FAQPage` | ✅ |
| Markets | 10 locales: `in, us, gb, ca, au, nz, ie, sg, ae, za`, each with localized copy & currency | ✅ (markets.xml) |
| Pages per market | home, pricing, enterprise, features (+9 detail), solutions (+4 detail), product, integrations, security, about, contact, demo, privacy, terms, resources, blog, guides, help; plus global `careers` | ✅ (sitemaps) |
| Pricing | Published per market as JSON-LD offers (India: Starter ₹3,500 / Professional ₹4,500 / Enterprise ₹8,000 per user/month; trial terms only as the page's structured data states them) | ✅ |
| Contact | `hello@`, `sales@`, `support@`, `security@`, `careers@` (JSON-LD contact points + mailto links) | ✅ |
| Public API | **None.** `robots.txt` has `Disallow: /api/` for every crawler; the app backend lives on `app.raivatedu.com` behind auth | ✅ (so this server scrapes public HTML only, and never `/api/`) |
| Course catalog / accounts / site search | **Do not exist** publicly. "Courses" (BBA, B.Tech, …) appear only as mock/sample data inside product screenshots | ✅ (so no `list_courses` / `get_course_details` tools — see below) |

### Capability → tool mapping

| Suggested tool | Decision | Reason |
| --- | --- | --- |
| `check_website_status` | ✅ Implemented (`raivatedu_check_website_status`) | Reachability via HEAD |
| `get_website_info` | ✅ `raivatedu_get_website_info` | From JSON-LD |
| `search_website` | ✅ `raivatedu_search_content` | Client-side search over known pages (no server API) |
| `get_page_content` | ✅ `raivatedu_get_page_content` | Domain- & catalog-restricted |
| `get_contact_information` | ✅ `raivatedu_get_contact_information` | From JSON-LD contact points |
| `list_courses`, `search_courses`, `get_course_details` | ❌ Omitted | **No course catalog exists** — implementing these would require fabricating data |
| `list_categories` | ❌ Omitted | No course taxonomy; the real taxonomies are features & solutions (covered below) |
| `get_learning_resources` | ✅ as `raivatedu_list_resources` | "Resources" = admissions playbook articles |
| — | ✅ `raivatedu_get_pricing` | Pricing is a first-class, verified capability |
| — | ✅ `raivatedu_list_features`, `raivatedu_list_solutions`, `raivatedu_list_pages` | Verified site taxonomies / navigation |

---

## What this server exposes

Tools, resources (some templated per market) and prompts — all read-only. `GET /version` on the HTTP transport reports the live counts.

---

## Architecture

```
raivat-education-mcp/
├── src/
│   ├── index.ts                 # Entry point: stdio transport, CLI flags, graceful shutdown
│   ├── server.ts                # Builds McpServer + context; wires tools/resources/prompts
│   ├── config.ts                # Env config + the verified page/market/feature catalog
│   ├── context.ts               # ServerContext (config + client + logger)
│   ├── tools/
│   │   ├── index.ts             # registerAllTools
│   │   ├── shared.ts            # response formatting, shared Zod fields, char limit
│   │   ├── website.ts           # check_website_status, get_website_info, get_contact_information
│   │   ├── pages.ts             # list_pages, get_page_content, search_content
│   │   ├── pricing.ts           # get_pricing
│   │   └── catalog.ts           # list_features, list_solutions, list_resources
│   ├── services/
│   │   ├── website-client.ts    # SSRF-safe fetch: timeouts, retries, rate limiting
│   │   └── content-parser.ts    # Cheerio + JSON-LD extraction (pricing/org/software/FAQ)
│   ├── resources/index.ts       # raivatedu://info | contact | pages/{market} | pricing/{market}
│   ├── prompts/index.ts         # find_relevant_plan, compare_plans, summarize_page, navigate_website
│   └── utils/
│       ├── url.ts               # SSRF guard + catalog generation + path normalization
│       ├── errors.ts            # Typed errors + MCP error-result builder
│       └── logger.ts            # Leveled stderr-only logger
├── tests/                       # Vitest unit + integration tests (+ optional live smoke)
├── .env.example
├── claude_desktop_config.example.json
├── eval/evaluation.xml          # MCP evaluation questions
├── package.json / tsconfig.json / vitest.config.ts
├── README.md / LICENSE
```

**Design highlights**

- **stdio transport**, logs on **stderr only** (stdout stays a clean JSON-RPC stream).
- **Structured output**: every tool declares an `outputSchema` and returns `structuredContent` (validated against it) plus a markdown rendering as text. `response_format` is deprecated and ignored.
- **Attribution**: links to raivatedu.com in tool and resource output carry `utm_source=mcp&utm_medium=ai_agent&utm_campaign=<tool>` (`source_url` citations stay untagged).
- **JSON-LD first**: pricing/org/contact come from the site's own machine-readable schema.org data, not brittle CSS selectors.
- **SSRF-hardened**: outbound requests are restricted to `raivatedu.com`/`www.raivatedu.com` over HTTPS **and** to the sitemap-derived page allowlist; `/api/` is always blocked.
- **Polite client**: per-request timeout, bounded retries with backoff, and a minimum interval between requests.

---

## Prerequisites

- **Node.js ≥ 18** (fetch is built in; developed/tested on Node 22+). [Download Node.js](https://nodejs.org/).
- **npm** (bundled with Node).
- **Claude Desktop** (latest) for the integration section — [download](https://claude.ai/download).

---

## Installation, build & run

```bash
# 1. Get the project (clone your fork, or copy this folder)
cd raivat-education-mcp

# 2. Install dependencies
npm install

# 3. Build TypeScript -> dist/
npm run build

# 4. (optional) configure — all vars are optional
cp .env.example .env

# 5. Run the server (stdio). It waits for an MCP client on stdin/stdout.
npm start
# or directly:
node dist/index.js
```

Quick sanity checks (do **not** speak MCP, just prove the binary works):

```bash
node dist/index.js --version   # -> 1.0.0
node dist/index.js --help
```

Development with auto-reload:

```bash
npm run dev
```

---

## Run over HTTP / Docker

The same server also speaks Streamable HTTP (stateless, JSON responses):

```bash
npm run build
npm run start:http                 # or: TRANSPORT=http node dist/index.js
PORT=3100 npm run start:http       # PORT defaults to 3000
```

| Path | What it is |
| --- | --- |
| `POST /mcp` | The MCP endpoint (Streamable HTTP, stateless). No API key. |
| `GET /mcp` | `405` by design (no server-sent event stream in stateless mode). |
| `GET /health` | Liveness: `{"status":"ok"}`. |
| `GET /version` | Name, version, live tool/resource/prompt counts and `mcp_endpoint`. |
| `GET /.well-known/mcp.json` | Discovery document. Its endpoint comes from `PUBLIC_BASE_URL` (default `https://mcp.raivatedu.com`). |
| `GET /.well-known/mcp/server-card.json` | Server card: name, title, version, transport endpoint, no auth, repository. |
| `GET /llms.txt` | Plain-text description for assistants; the tool list is generated from `tools/list`. |
| `GET /` | Status page. |

Try it with the MCP Inspector CLI:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --method tools/list
```

Docker (multi-stage image, runs as a non-root user, HTTP on port 3000):

```bash
docker build -t raivatedu-mcp .
docker run -p 3000:3000 raivatedu-mcp
```

For local use set `PUBLIC_BASE_URL=http://localhost:3000` so discovery points at your machine. The hosted endpoint is `https://mcp.raivatedu.com/mcp` (pending confirmation). See [Environment variables](#environment-variables) for the HTTP guards (`MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_RATE_LIMIT_PER_MIN`, `TRUST_PROXY`).

---

## Claude Desktop integration

1. **Install Node.js** (see prerequisites) and note the absolute path to `node`:
   - macOS/Linux: `which node`
   - Windows (PowerShell): `(Get-Command node).Source`
2. **Build** the project (`npm run build`) so `dist/index.js` exists.
3. **Find the absolute path** to the built entry file:
   - macOS/Linux: `realpath dist/index.js`
   - Windows (PowerShell): `(Resolve-Path dist\index.js).Path`
4. **Edit Claude Desktop's config file** (`claude_desktop_config.json`):
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - You can open it from Claude Desktop → **Settings → Developer → Edit Config**.
5. Add this server under `mcpServers` (see `claude_desktop_config.example.json`). **Replace the example path with your own absolute path.** On Windows, use double backslashes (`\\`).

   ```jsonc
   {
     "mcpServers": {
       "raivat-education": {
         "command": "node",
         "args": ["/ABSOLUTE/PATH/TO/raivat-education-mcp/dist/index.js"],
         "env": {
           "RAIVATEDU_DEFAULT_MARKET": "in"
         }
       }
     }
   }
   ```

   Windows example `args`:
   `["C:\\Users\\you\\Desktop\\Raivat_MCP\\dist\\index.js"]`

6. **Fully quit and reopen Claude Desktop** (not just close the window).
7. **Verify**: open a new chat → click the **tools/plug icon** → you should see **raivat-education** and its tools. Ask: *"Is the RaivatEdu website up?"*

> Tip: prefer `node` + absolute `dist/index.js` over `npx`/`tsx` for reliability. Ensure `node` is on the PATH Claude Desktop sees, or use an absolute path to the `node` binary in `command`.

---

## MCP tool reference

All tools are **read-only** (`readOnlyHint: true`) and declare an `outputSchema`; the object is in `structuredContent` and the text is markdown. The old `response_format` argument is still accepted but ignored. Markets: `in, us, gb, ca, au, nz, ie, sg, ae, za` (default `in`, configurable).

### `raivatedu_check_website_status`
Check reachability and response time (HTTP HEAD to a market home page).
- **Input**: `market?`
- **Output**: `{ reachable, status, url, response_time_ms, checked_at }`
- **Example**: `{ "market": "in" }` → `✅ reachable, HTTP 200, 180 ms`

### `raivatedu_get_website_info`
Product, organization and markets overview from JSON-LD.
- **Input**: `market?`
- **Output**: `{ product{...}, organization{...}, markets[], source_url }`

### `raivatedu_get_contact_information`
Published contact emails + contact/demo page URLs (does **not** send anything).
- **Input**: `market?`
- **Output**: `{ general_email, contact_points[], contact_page, demo_page }`

### `raivatedu_get_started`
The next step for someone who wants to try or buy: UTM-tagged demo, contact and pricing links for a market. No network call; `signup_url` is `null` because no self-serve signup page is published.
- **Input**: `market?`
- **Output**: `{ market, demo_url, contact_url, pricing_url, signup_url: null, note, call_to_action }`

### `raivatedu_get_pricing`
Subscription plans & prices for a market, from pricing JSON-LD offers. Currency comes from the offers' `priceCurrency` (the market's usual currency only as a fallback). Free-trial terms are reported only when the page's structured data states them.
- **Input**: `market?`
- **Output**: `{ market, currency, plans:[{ plan, billing, price, currency, unit, minUsers?, maxUsers?, url? }], trial_terms: { text, source } | null, source_url }`
- **Example (`in`)**: Starter `3500 INR`, Professional `4500 INR`, Enterprise `8000 INR`, per user/month.

### `raivatedu_list_features`
The 9 feature areas with URLs (optional live descriptions).
- **Input**: `market?`, `include_descriptions?` (default false)
- **Output**: `{ market, count, features:[{ slug, label, url, description? }] }`

### `raivatedu_list_solutions`
The 4 audience segments (Schools, Colleges & Universities, Coaching Institutes, Training & EdTech).
- **Input**: `market?`, `include_descriptions?`
- **Output**: `{ market, count, solutions:[{ slug, label, url, description? }] }`

### `raivatedu_list_resources`
Resource articles + resources/blog/guides/help landing pages.
- **Input**: `market?`, `include_descriptions?`
- **Output**: `{ market, landing_pages{...}, count, articles:[{ slug, label, url, description? }] }`

### `raivatedu_list_pages`
The site navigation map (verified page catalog) for a market.
- **Input**: `market?`, `type?` (e.g. `"feature"`, `"solution"`, `"resource-article"`)
- **Output**: `{ market, count, pages:[{ path, url, type, market }] }`

### `raivatedu_get_page_content`
Fetch & summarize a specific public page (title, description, outline, body text, links, FAQ).
- **Input**: `path` (required, path or full raivatedu.com URL), `max_text_chars?` (200–20000, default 6000), `include_links?` (default true)
- **Output**: `{ url, type, title, description, canonical, headings[], text, faqs[], links[] }`
- **Errors**: unknown path → *"not a known public RaivatEdu page"*; external host → refused (SSRF); `/api/*` → blocked.

### `raivatedu_search_content`
Keyword search across the content-rich pages for a market (pages whose path matches the query first; capped at 12 pages on the public HTTP transport by default); ranked results with snippets. Returns an error, not "no matches", when the site cannot be reached.
- **Input**: `query` (required, 2–200 chars), `market?`, `limit?` (1–20, default 5)
- **Output**: `{ query, market, pages_searched, pages_failed, count, note?, results:[{ title, url, type, score, snippet }] }`
- Empty matches return `count: 0` (not an error).

---

## Resources & prompts

**Resources** (read-only, JSON):
- `raivatedu://info` — product/org/markets overview
- `raivatedu://contact` — contact details
- `raivatedu://pages/{market}` — page catalog (templated; lists all 10 markets)
- `raivatedu://pricing/{market}` — pricing plans (templated; lists all 10 markets)

**Prompts**:
- `find_relevant_plan` — args `institution_type`, `team_size?`, `market?`
- `compare_plans` — arg `market?`
- `summarize_page` — arg `path`
- `navigate_website` — args `goal`, `market?`

---

## Environment variables

All optional; the server runs with zero config. See `.env.example`.

| Variable | Default | Description |
| --- | --- | --- |
| `RAIVATEDU_DEFAULT_MARKET` | `in` | Market used when a tool call omits one. One of the 10 market codes. |
| `RAIVATEDU_TIMEOUT_MS` | `15000` | Per-request timeout (1000–60000). |
| `RAIVATEDU_MIN_REQUEST_INTERVAL_MS` | `250` | Minimum spacing between outbound requests (0–10000). |
| `RAIVATEDU_MAX_RETRIES` | `2` | Retries for transient failures (0–5). |
| `RAIVATEDU_USER_AGENT` | descriptive default | Override the outbound User-Agent. |
| `RAIVATEDU_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent`. |
| `RAIVATEDU_CACHE_TTL_MS` | `600000` | Page cache TTL (0 turns caching off, max 3600000). |
| `RAIVATEDU_CACHE_MAX_ENTRIES` | `500` | Maximum cached pages (LRU). |
| `RAIVATEDU_MAX_CONCURRENT_REQUESTS` | `4` | Simultaneous outbound requests (1–32). |
| `RAIVATEDU_SEARCH_MAX_PAGES` | none on stdio, `12` on HTTP | Pages one search may fetch (0 = no cap). |
| `RAIVATEDU_MAX_RESPONSE_BYTES` | `2097152` | Largest website response read. |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1],mcp.raivatedu.com` | HTTP only: Host allowlist for `/mcp`. |
| `MCP_ALLOWED_ORIGINS` | `https://mcp.raivatedu.com,https://raivatedu.com,https://www.raivatedu.com` | HTTP only: browser origins allowed on `/mcp`. |
| `MCP_RATE_LIMIT_PER_MIN` | `60` | HTTP only: requests per minute per IP (0 = off). |
| `RAIVATEDU_SITEMAP_REFRESH_MS` | `86400000` | Rebuild the page catalog from the sitemap this often (0 = snapshot only). |
| `RAIVATEDU_USAGE_LOG` | on for HTTP, off for stdio | One anonymous JSON line per tool call on stderr (`event: "tool_call"`: tool, client, transport, market, ok, errorKind, latencyMs). Never records queries, paths or IPs. `0` off, `1` on. |
| `PUBLIC_BASE_URL` | `https://mcp.raivatedu.com` | HTTP only: public base URL advertised in discovery, `/` and `/version`. |
| `TRUST_PROXY` | `0` | HTTP only: number of trusted proxy hops (0 = socket address; `true`/`1` = 1). The rate limit keys on the `X-Forwarded-For` entry that many hops from the right. Behind Cloudflare then Apache use `2`, or configure Apache `mod_remoteip` with Cloudflare's ranges and use `1`. `CF-Connecting-IP` is not trusted. |

---

## Testing

```bash
npm test          # offline unit + integration tests (mocked HTTP)
npm run typecheck # tsc --noEmit
RUN_SMOKE=1 npm test   # also runs optional live tests against raivatedu.com
npm run check:versions # package.json and server.json versions match
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, build, the offline tests, `check:versions` and `npm audit --omit=dev --audit-level=high` on every pull request and push to `main`.

Coverage includes: config parsing, SSRF/path validation & catalog, HTML/JSON-LD parsing, the HTTP client (success, 404, 5xx retries, network errors, timeouts, host blocking), tool discovery, every tool's happy path, input validation, unknown-path & SSRF rejection, empty search results, and malformed-HTML/JSON-LD handling.

### MCP Inspector

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
# or:  npm run inspector
```

The Inspector opens a UI where you can list/call tools, read resources, and try prompts interactively.

---

## Example conversations

Once connected in Claude Desktop you can ask:

- *"Is the RaivatEdu website up right now?"* → `raivatedu_check_website_status`
- *"What is RaivatEdu and who makes it?"* → `raivatedu_get_website_info`
- *"How much does RaivatEdu cost in India? Compare the plans."* → `raivatedu_get_pricing` (try the `compare_plans` prompt)
- *"I run a coaching institute with ~15 counsellors — which plan and solution fits?"* → `find_relevant_plan` → `raivatedu_get_pricing` + `raivatedu_list_solutions`
- *"Where does the site talk about WhatsApp follow-ups?"* → `raivatedu_search_content`
- *"Summarize the Admissions feature page."* → `summarize_page` → `raivatedu_get_page_content`
- *"List all the resource articles and give me the one about migrating from spreadsheets."* → `raivatedu_list_resources` + `raivatedu_get_page_content`
- *"What are RaivatEdu's sales and support email addresses?"* → `raivatedu_get_contact_information`
- *"Show me the US pricing resource."* → read resource `raivatedu://pricing/us`

---

## End-to-end verification checklist

- [ ] `npm install` completes.
- [ ] `npm run build` succeeds; `dist/index.js` exists.
- [ ] `node dist/index.js --version` prints `1.0.0`.
- [ ] `npm test` → all offline tests pass.
- [ ] `RUN_SMOKE=1 npm test` → live tests pass (site reachable, INR pricing present).
- [ ] `npx @modelcontextprotocol/inspector node dist/index.js` lists the tools, 4 prompts and resources.
- [ ] In Inspector, `raivatedu_get_pricing {market:"in"}` returns 3 INR plans.
- [ ] In Inspector, `raivatedu_get_page_content {path:"https://evil.example.com"}` is refused.
- [ ] Claude Desktop config added with the correct absolute path; app fully restarted.
- [ ] Tools icon shows **raivat-education** and its tools.
- [ ] "Is the RaivatEdu website up?" triggers `raivatedu_check_website_status` and answers.

---

## Security considerations

- **Read-only.** No tool writes, submits forms, sends messages, or authenticates. Contact tools only surface already-public email addresses.
- **SSRF prevention.** Outbound fetches are restricted to `raivatedu.com`/`www.raivatedu.com` over HTTP(S), and only to paths in the page allowlist (built from the live sitemap, shape-checked, with the verified snapshot as fallback). Full URLs are parsed and host-checked. Redirects are followed manually (at most 5 hops) and each `Location` is checked **before** it is fetched: HTTPS only, an allowed host, never `/api/`, and the target path must itself be in the catalog. Responses are capped at 2 MB (declared or streamed) and must be HTML or XML. Arbitrary/internal/external URLs are refused.
- **HTTP endpoint guards.** `POST /mcp` checks the `Host` header (`MCP_ALLOWED_HOSTS`) and the browser `Origin` (`MCP_ALLOWED_ORIGINS`; no Origin and localhost pass), rate-limits each client IP (`MCP_RATE_LIMIT_PER_MIN`, default 60; set `TRUST_PROXY` to the number of proxy hops, `2` behind Cloudflare then Apache), and answers oversized or malformed bodies with JSON errors that carry no stack trace.
- **Load on the website.** One shared client per process caps simultaneous outbound requests (`RAIVATEDU_MAX_CONCURRENT_REQUESTS`) and caches successful pages for 10 minutes (`RAIVATEDU_CACHE_TTL_MS`).
- **robots.txt respected.** `/api/` is always blocked, matching the site's `Disallow: /api/`.
- **No access-control bypass.** The server never attempts auth, CAPTCHAs, paywalls, or private areas.
- **Untrusted content.** Page text is treated as **data, not instructions** (stated in the server instructions and the `summarize_page` prompt). Returned text is inert; nothing is executed.
- **No secrets.** No credentials, cookies, or tokens are used, stored, or logged. Logs go to stderr and contain only URLs/status/timing.
- **Polite.** Timeouts, bounded retries with backoff, and a configurable minimum request interval protect the origin.
- **Input validation.** All inputs validated with Zod (`.strict()` where applicable) with length/range constraints.

---

## Known limitations

- **Not a course catalog.** RaivatEdu publishes no public courses, categories, user accounts, or search API, so there are intentionally **no** `list_courses`/`get_course_details`/`list_categories` tools. Course-like names on the site are sample data only.
- **`search_content` is client-side** over the curated content pages of a market (capped per call on HTTP, see `RAIVATEDU_SEARCH_MAX_PAGES`) — it is not a full-site crawl or a live search index.
- **Scope = public marketing pages.** The authenticated product (`app.raivatedu.com`) and `/api/` are out of scope by design.
- **Catalog follows the sitemap.** At startup (and every 24 h, `RAIVATEDU_SITEMAP_REFRESH_MS`) the server rebuilds the page list from `https://www.raivatedu.com/sitemap.xml` in the background; until that succeeds, or if it fails, it serves the verified 2026-10-13 snapshot. `raivatedu_list_pages` reports `catalog_source` (`sitemap` or `snapshot`) and `catalog_fetched_at`. Only URLs that match known shapes are accepted (a known market, a known top-level page, or a lowercase slug under `features/`, `solutions/` or `resources/`, plus `/careers`), so the sitemap can add same-site public pages but nothing else. A new **market** still needs a code change.
- **`include_descriptions: true`** issues one request per item (slower); off by default.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Server not listed in Claude Desktop | Check `claude_desktop_config.json` is valid JSON (no trailing commas), the path is **absolute** and uses `\\` on Windows, then **fully restart** the app. |
| "Server disconnected" / spawn error | Ensure `node` is on PATH or use an absolute path in `command`; confirm `dist/index.js` exists (`npm run build`). |
| Tools appear but every call errors with network messages | Check connectivity to `https://www.raivatedu.com`; raise `RAIVATEDU_TIMEOUT_MS`; inspect stderr logs (`RAIVATEDU_LOG_LEVEL=debug`). |
| "not a known public RaivatEdu page" | Use `raivatedu_list_pages` to get valid paths; the server only fetches allowlisted pages. |
| Garbled MCP / protocol errors | Something wrote to **stdout**. This server logs only to stderr — don't add `console.log`. Rebuild after changes. |
| Inspector can't connect | Rebuild first; run `npx @modelcontextprotocol/inspector node dist/index.js` from the project root. |
| `npm audit` shows dev-dependency advisories | They are in the test toolchain (vitest/esbuild). `npm audit --omit=dev` reports **0** for shipped code. |

---

## License

MIT — see [LICENSE](./LICENSE). "RaivatEdu" marks belong to RaivatEdu Technologies Pvt. Ltd.
