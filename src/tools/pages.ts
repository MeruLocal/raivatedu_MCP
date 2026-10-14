/** Tools: list_pages, get_page_content, search_content. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { MARKETS, type Market } from "../config.js";
import {
  toToolError,
  ValidationError,
  WebsiteClientError,
} from "../utils/errors.js";
import { CATALOG, resolveToSafeUrl, type CatalogPage } from "../utils/url.js";
import { parsePage, type ParsedPage } from "../services/content-parser.js";
import { buildResult, marketField, responseFormatField } from "./shared.js";

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Page types that carry rich, searchable marketing copy. */
const SEARCHABLE_TYPES: ReadonlySet<CatalogPage["type"]> = new Set([
  "home",
  "pricing",
  "enterprise",
  "features-index",
  "feature",
  "solutions-index",
  "solution",
  "product",
  "integrations",
  "security",
  "about",
  "resource-article",
]);

function pagesForMarket(market: Market): CatalogPage[] {
  return CATALOG.filter((p) => p.market === market || p.market === null);
}

/** Fixed search priority for pages whose path does not match the query. */
const SEARCH_PRIORITY: readonly CatalogPage["type"][] = [
  "home",
  "pricing",
  "product",
  "features-index",
  "solutions-index",
  "enterprise",
  "integrations",
  "security",
  "about",
  "feature",
  "solution",
  "resource-article",
];

/**
 * Choose which searchable pages to fetch for a query: pages whose path
 * (without the market prefix) contains a query term first, then the rest in
 * a fixed priority order, capped at `max` (0 = no cap). Needs no fetch.
 */
export function selectSearchCandidates(
  pages: readonly CatalogPage[],
  terms: readonly string[],
  max: number,
): CatalogPage[] {
  const searchable = pages.filter((p) => SEARCHABLE_TYPES.has(p.type));
  const rank = (p: CatalogPage) => {
    const i = SEARCH_PRIORITY.indexOf(p.type);
    return i === -1 ? SEARCH_PRIORITY.length : i;
  };
  const pathMatches = (p: CatalogPage) => {
    const local = p.path.toLowerCase().replace(/^\/[a-z]{2}(?=\/|$)/, "");
    return terms.some((t) => local.includes(t));
  };
  const matched = searchable.filter(pathMatches);
  const rest = searchable
    .filter((p) => !pathMatches(p))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
  const ordered = [...matched, ...rest];
  return max > 0 ? ordered.slice(0, max) : ordered;
}

export function registerPageTools(server: McpServer, ctx: ServerContext): void {
  // --- list_pages ----------------------------------------------------------
  server.registerTool(
    "raivatedu_list_pages",
    {
      title: "List RaivatEdu Pages",
      description: `List the public pages available on RaivatEdu for a market — a navigation map of the site.

Returns the verified set of pages (derived from the site's sitemap): home, pricing, enterprise, features (+ detail pages), solutions (+ detail pages), product, integrations, security, about, contact, demo, privacy, terms, resources, blog, guides, help, plus the global careers page. Feed any returned path to raivatedu_get_page_content.

Args:
  - market (optional): locale to list (${MARKETS.join(", ")}); defaults to the configured market.
  - type (optional): filter to one page category (e.g. "feature", "solution", "resource-article").
  - response_format ('markdown' | 'json'): output format (default markdown).

Returns JSON shape:
  { "market": string, "count": number, "pages": [ { "path", "url", "type", "market" } ] }`,
      inputSchema: {
        market: marketField,
        type: z
          .string()
          .optional()
          .describe(
            "Optional page category filter, e.g. 'feature', 'solution', 'resource-article', 'pricing'.",
          ),
        response_format: responseFormatField,
      },
      annotations: { ...READONLY, openWorldHint: false },
    },
    async ({ market, type, response_format }) => {
      try {
        const m: Market = market ?? ctx.config.defaultMarket;
        let pages = pagesForMarket(m);
        if (type) {
          const t = type.trim().toLowerCase();
          pages = pages.filter((p) => p.type === t);
        }
        const structured = {
          market: m,
          count: pages.length,
          pages: pages.map((p) => ({
            path: p.path,
            url: p.url,
            type: p.type,
            market: p.market,
          })),
        };
        const lines = [
          `# RaivatEdu pages — ${m.toUpperCase()}${type ? ` (type: ${type})` : ""}`,
          `Found ${pages.length} pages.`,
          "",
          ...pages.map((p) => `- [${p.type}] ${p.path}`),
        ];
        return buildResult(lines.join("\n"), structured, response_format);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  // --- get_page_content ----------------------------------------------------
  server.registerTool(
    "raivatedu_get_page_content",
    {
      title: "Get RaivatEdu Page Content",
      description: `Fetch and summarize the text of a specific public RaivatEdu page.

Accepts a path (e.g. "/in/pricing" or "in/features/admissions") or a full raivatedu.com URL. For safety the page MUST be one of the known public pages (use raivatedu_list_pages to discover them); arbitrary or external URLs are refused, and /api/ paths are blocked per robots.txt.

Returns the page title, meta description, heading outline, main body text (truncated), internal links, and any FAQ entries found in the page's structured data.

Args:
  - path (string, required): page path or full raivatedu.com URL.
  - max_text_chars (number): cap on returned body text, 200–20000 (default 6000).
  - include_links (boolean): include the list of internal links (default true).
  - response_format ('markdown' | 'json'): output format (default markdown).

Returns JSON shape:
  {
    "url": string, "type": string, "title": string, "description": string,
    "canonical": string | null,
    "headings": [ { "level": number, "text": string } ],
    "text": string,
    "faqs": [ { "question": string, "answer": string } ],
    "links": [ { "text": string, "url": string } ]
  }

Errors:
  - "not a known public RaivatEdu page" if the path is unknown — call raivatedu_list_pages.
  - "Page not found" (HTTP 404) if the page no longer exists.`,
      inputSchema: {
        path: z
          .string()
          .min(1, "A page path or URL is required.")
          .describe('Page path (e.g. "/in/pricing") or full raivatedu.com URL.'),
        max_text_chars: z
          .number()
          .int()
          .min(200)
          .max(20000)
          .default(6000)
          .describe("Maximum characters of body text to return (200–20000)."),
        include_links: z
          .boolean()
          .default(true)
          .describe("Whether to include the page's internal links."),
        response_format: responseFormatField,
      },
      annotations: READONLY,
    },
    async ({ path, max_text_chars, include_links, response_format }) => {
      try {
        const page = resolveToSafeUrl(path);
        const { body } = await ctx.client.get(page.url);
        const parsed: ParsedPage = parsePage(body, max_text_chars);

        const structured = {
          url: page.url,
          type: page.type,
          title: parsed.title,
          description: parsed.description,
          canonical: parsed.canonical,
          headings: parsed.headings,
          text: parsed.text,
          faqs: parsed.faqs,
          links: include_links ? parsed.internalLinks : [],
        };

        const lines = [
          `# ${parsed.title || page.path}`,
          "",
          parsed.description ? `> ${parsed.description}` : "",
          "",
          `**URL:** ${page.url}  `,
          `**Type:** ${page.type}`,
          "",
        ];
        if (parsed.headings.length) {
          lines.push("## Outline");
          for (const h of parsed.headings) {
            lines.push(`${"  ".repeat(Math.max(0, h.level - 1))}- ${h.text}`);
          }
          lines.push("");
        }
        lines.push("## Content");
        lines.push(parsed.text || "(no extractable body text)");
        lines.push("");
        if (parsed.faqs.length) {
          lines.push("## FAQ");
          for (const f of parsed.faqs) {
            lines.push(`**Q: ${f.question}**`);
            lines.push(f.answer);
            lines.push("");
          }
        }
        if (include_links && parsed.internalLinks.length) {
          lines.push(`## Links (${parsed.internalLinks.length})`);
          for (const l of parsed.internalLinks.slice(0, 40)) {
            lines.push(`- [${l.text}](${l.url})`);
          }
        }
        return buildResult(lines.join("\n"), structured, response_format);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  // --- search_content ------------------------------------------------------
  server.registerTool(
    "raivatedu_search_content",
    {
      title: "Search RaivatEdu Content",
      description: `Search the public RaivatEdu website for a keyword or phrase and return the most relevant pages with matching snippets.

There is no public search API on the site, so this tool performs a client-side search: it fetches a curated set of content-rich pages for the market, scores them against your query (title, headings, description and body), and returns the best matches. Use it to answer "where does the site talk about X?" questions, then drill in with raivatedu_get_page_content.

Args:
  - query (string, required): 2–200 chars; words are matched case-insensitively.
  - market (optional): locale to search (${MARKETS.join(", ")}); defaults to the configured market.
  - limit (number): max results, 1–20 (default 5).
  - response_format ('markdown' | 'json'): output format (default markdown).

Returns JSON shape:
  {
    "query": string, "market": string, "pages_searched": number, "pages_failed": number,
    "count": number, "note"?: string,
    "results": [ { "title", "url", "type", "score": number, "snippet": string } ]
  }

Notes:
  - Searches the market's content-rich pages (pages whose path matches the query first); the operator may cap how many pages one search fetches. It does not crawl the entire site.
  - Returns an empty results array (not an error) when nothing matches.
  - Returns an error if the site cannot be reached, and a note when some pages could not be fetched (results may then be incomplete).`,
      inputSchema: {
        query: z
          .string()
          .min(2, "Query must be at least 2 characters.")
          .max(200, "Query must not exceed 200 characters.")
          .describe("Keyword or phrase to search for."),
        market: marketField,
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe("Maximum number of results to return (1–20)."),
        response_format: responseFormatField,
      },
      annotations: READONLY,
    },
    async ({ query, market, limit, response_format }) => {
      try {
        const m: Market = market ?? ctx.config.defaultMarket;
        const terms = query
          .toLowerCase()
          .split(/\s+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2);
        if (terms.length === 0) {
          throw new ValidationError(
            "Query must contain at least one word of 2+ characters.",
          );
        }

        const candidates = selectSearchCandidates(
          pagesForMarket(m),
          terms,
          ctx.config.searchMaxPages ?? 0,
        );

        const failures: WebsiteClientError[] = [];
        const fetched = await Promise.all(
          candidates.map(async (p) => {
            let body: string;
            try {
              ({ body } = await ctx.client.get(p.url));
            } catch (err) {
              // Only fetch failures are tolerated; anything else is a bug.
              if (!(err instanceof WebsiteClientError)) throw err;
              failures.push(err);
              return null;
            }
            return { page: p, parsed: parsePage(body, 4000) };
          }),
        );
        const ok = fetched.filter(
          (x): x is { page: CatalogPage; parsed: ParsedPage } => x !== null,
        );

        if (ok.length === 0 && candidates.length > 0) {
          const first = failures[0];
          return toToolError(
            new WebsiteClientError(
              `Could not reach raivatedu.com to search; nothing was searched${first ? ` (${first.message})` : ""}. Retry shortly or call raivatedu_check_website_status.`,
              { status: first?.status, retryable: first?.retryable ?? true },
            ),
          );
        }

        const note =
          failures.length > 0
            ? `Note: ${failures.length} of ${candidates.length} pages could not be fetched; results may be incomplete.`
            : undefined;

        const results = ok
          .map(({ page, parsed }) => {
            const haystacks = {
              title: parsed.title.toLowerCase(),
              headings: parsed.headings.map((h) => h.text).join(" ").toLowerCase(),
              description: parsed.description.toLowerCase(),
              text: parsed.text.toLowerCase(),
            };
            let score = 0;
            for (const term of terms) {
              score += countOccurrences(haystacks.title, term) * 5;
              score += countOccurrences(haystacks.description, term) * 3;
              score += countOccurrences(haystacks.headings, term) * 2;
              score += countOccurrences(haystacks.text, term) * 1;
            }
            return {
              title: parsed.title,
              url: page.url,
              type: page.type,
              score,
              snippet: makeSnippet(parsed, terms),
            };
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        const structured = {
          query,
          market: m,
          pages_searched: ok.length,
          pages_failed: failures.length,
          count: results.length,
          results,
          ...(note ? { note } : {}),
        };

        const lines = [
          `# Search results for "${query}" (${m.toUpperCase()})`,
          `Searched ${structured.pages_searched} pages; ${results.length} match(es).`,
          ...(note ? [note] : []),
          "",
        ];
        if (results.length === 0) {
          lines.push(
            "No matching pages. Try broader or different keywords, or use raivatedu_list_pages to browse.",
          );
        }
        for (const r of results) {
          lines.push(`## ${r.title} (score ${r.score})`);
          lines.push(`- ${r.url}`);
          if (r.snippet) lines.push(`- …${r.snippet}…`);
          lines.push("");
        }
        return buildResult(lines.join("\n"), structured, response_format);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Build a short snippet of body text around the first matched term. */
function makeSnippet(parsed: ParsedPage, terms: string[]): string {
  const text = parsed.text;
  const lower = text.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) return text.slice(0, 160).trim();
  const start = Math.max(0, pos - 80);
  const end = Math.min(text.length, pos + 120);
  return text.slice(start, end).trim();
}
