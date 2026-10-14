/** Tools: list_features, list_solutions, list_resources. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import {
  SITE_ORIGIN,
  MARKETS,
  FEATURE_SLUGS,
  FEATURE_LABELS,
  SOLUTION_SLUGS,
  SOLUTION_LABELS,
  RESOURCE_SLUGS,
  type Market,
} from "../config.js";
import { toToolError } from "../utils/errors.js";
import { parsePage } from "../services/content-parser.js";
import {
  buildResult,
  marketField,
  responseFormatField,
  type ResponseFormat,
} from "./shared.js";

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const includeDescriptionsField = z
  .boolean()
  .default(false)
  .describe(
    "If true, fetch each page live to include its meta description (slower, one request per item). If false (default), return only verified labels and URLs.",
  );

interface CatalogEntry {
  slug: string;
  label: string;
  url: string;
  description?: string;
}

/** Optionally enrich entries with live meta descriptions, fetched in parallel. */
async function enrich(
  ctx: ServerContext,
  entries: CatalogEntry[],
  include: boolean,
): Promise<CatalogEntry[]> {
  if (!include) return entries;
  return Promise.all(
    entries.map(async (e) => {
      try {
        const { body } = await ctx.client.get(e.url);
        const parsed = parsePage(body);
        return { ...e, description: parsed.description || parsed.title };
      } catch {
        return { ...e, description: undefined };
      }
    }),
  );
}

function render(
  title: string,
  entries: CatalogEntry[],
  structured: Record<string, unknown>,
  format: ResponseFormat,
): ReturnType<typeof buildResult> {
  const lines = [`# ${title}`, ""];
  for (const e of entries) {
    lines.push(`## ${e.label}`);
    lines.push(`- URL: ${e.url}`);
    if (e.description) lines.push(`- ${e.description}`);
    lines.push("");
  }
  return buildResult(lines.join("\n"), structured, format);
}

export function registerCatalogTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  server.registerTool(
    "raivatedu_list_features",
    {
      title: "List RaivatEdu Features",
      description: `List the product feature areas RaivatEdu documents, each with its dedicated feature page URL.

The nine feature areas are fixed site sections (Fee management, Students & batches, Admissions, Enrolment & renewals, Attendance, Certificates, Communication, Reports, Platform & security). Use raivatedu_get_page_content on a returned URL for the full write-up of a feature.

Args:
  - market (optional): locale for the URLs (${MARKETS.join(", ")}); defaults to the configured market.
  - include_descriptions (boolean): fetch each feature page's summary (default false).
  - response_format ('markdown' | 'json'): output format (default markdown).

Returns JSON shape:
  { "market": string, "count": number, "features": [ { "slug", "label", "url", "description"? } ] }`,
      inputSchema: {
        market: marketField,
        include_descriptions: includeDescriptionsField,
        response_format: responseFormatField,
      },
      annotations: READONLY,
    },
    async ({ market, include_descriptions, response_format }) => {
      try {
        const m: Market = market ?? ctx.config.defaultMarket;
        const base: CatalogEntry[] = FEATURE_SLUGS.map((slug) => ({
          slug,
          label: FEATURE_LABELS[slug],
          url: `${SITE_ORIGIN}/${m}/features/${slug}`,
        }));
        const features = await enrich(ctx, base, include_descriptions);
        const structured = { market: m, count: features.length, features };
        return render(
          `RaivatEdu features (${m.toUpperCase()})`,
          features,
          structured,
          response_format,
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "raivatedu_list_solutions",
    {
      title: "List RaivatEdu Solutions",
      description: `List the audience/solution segments RaivatEdu targets, each with its dedicated page URL.

The four segments are Schools, Colleges & Universities, Coaching Institutes, and Training & EdTech. Use raivatedu_get_page_content on a returned URL for the full pitch tailored to that segment.

Args:
  - market (optional): locale for the URLs (${MARKETS.join(", ")}); defaults to the configured market.
  - include_descriptions (boolean): fetch each solution page's summary (default false).
  - response_format ('markdown' | 'json'): output format (default markdown).

Returns JSON shape:
  { "market": string, "count": number, "solutions": [ { "slug", "label", "url", "description"? } ] }`,
      inputSchema: {
        market: marketField,
        include_descriptions: includeDescriptionsField,
        response_format: responseFormatField,
      },
      annotations: READONLY,
    },
    async ({ market, include_descriptions, response_format }) => {
      try {
        const m: Market = market ?? ctx.config.defaultMarket;
        const base: CatalogEntry[] = SOLUTION_SLUGS.map((slug) => ({
          slug,
          label: SOLUTION_LABELS[slug],
          url: `${SITE_ORIGIN}/${m}/solutions/${slug}`,
        }));
        const solutions = await enrich(ctx, base, include_descriptions);
        const structured = { market: m, count: solutions.length, solutions };
        return render(
          `RaivatEdu solutions (${m.toUpperCase()})`,
          solutions,
          structured,
          response_format,
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "raivatedu_list_resources",
    {
      title: "List RaivatEdu Resources",
      description: `List RaivatEdu's publicly available educational resource articles (admissions playbooks and guides), plus the resources, blog, guides and help landing pages.

The resource articles are practical pieces for education teams (e.g. first-response-time in admissions, WhatsApp templates, migrating from spreadsheets, admissions funnel metrics). Use raivatedu_get_page_content on a URL to read the full article text.

Args:
  - market (optional): locale for the URLs (${MARKETS.join(", ")}); defaults to the configured market.
  - include_descriptions (boolean): fetch each article's summary (default false).
  - response_format ('markdown' | 'json'): output format (default markdown).

Returns JSON shape:
  {
    "market": string,
    "landing_pages": { "resources", "blog", "guides", "help" },
    "count": number,
    "articles": [ { "slug", "label", "url", "description"? } ]
  }`,
      inputSchema: {
        market: marketField,
        include_descriptions: includeDescriptionsField,
        response_format: responseFormatField,
      },
      annotations: READONLY,
    },
    async ({ market, include_descriptions, response_format }) => {
      try {
        const m: Market = market ?? ctx.config.defaultMarket;
        const base: CatalogEntry[] = RESOURCE_SLUGS.map((slug) => ({
          slug,
          label: slug
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" "),
          url: `${SITE_ORIGIN}/${m}/resources/${slug}`,
        }));
        const articles = await enrich(ctx, base, include_descriptions);
        const landing_pages = {
          resources: `${SITE_ORIGIN}/${m}/resources`,
          blog: `${SITE_ORIGIN}/${m}/blog`,
          guides: `${SITE_ORIGIN}/${m}/guides`,
          help: `${SITE_ORIGIN}/${m}/help`,
        };
        const structured = {
          market: m,
          landing_pages,
          count: articles.length,
          articles,
        };

        const lines = [
          `# RaivatEdu resources (${m.toUpperCase()})`,
          "",
          "## Landing pages",
          `- Resources: ${landing_pages.resources}`,
          `- Blog: ${landing_pages.blog}`,
          `- Guides: ${landing_pages.guides}`,
          `- Help Center: ${landing_pages.help}`,
          "",
          "## Articles",
        ];
        for (const a of articles) {
          lines.push(`### ${a.label}`);
          lines.push(`- URL: ${a.url}`);
          if (a.description) lines.push(`- ${a.description}`);
          lines.push("");
        }
        return buildResult(lines.join("\n"), structured, response_format);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
