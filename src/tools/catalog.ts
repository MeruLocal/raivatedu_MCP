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
import { toToolError, WebsiteClientError } from "../utils/errors.js";
import { parsePage } from "../services/content-parser.js";
import { buildResult, marketField, responseFormatField } from "./shared.js";
import { withUtm } from "../utils/utm.js";
import { featuresOutput, resourcesOutput, solutionsOutput } from "./schemas.js";

/** UTM-tag entry URLs for output (after any fetch, which uses the bare URL). */
function tagged(entries: CatalogEntry[], tool: string): CatalogEntry[] {
  return entries.map((e) => ({ ...e, url: withUtm(e.url, tool) }));
}

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

interface Enriched {
  entries: CatalogEntry[];
  /** Number of items whose description could not be fetched (only when requested). */
  unavailable?: number;
  note?: string;
}

/**
 * Optionally enrich entries with live meta descriptions, fetched in parallel.
 * Fetch failures fall back to label + URL and are counted; any other error
 * (e.g. a parser bug) propagates.
 */
async function enrich(
  ctx: ServerContext,
  entries: CatalogEntry[],
  include: boolean,
): Promise<Enriched> {
  if (!include) return { entries };
  let unavailable = 0;
  const out = await Promise.all(
    entries.map(async (e) => {
      let body: string;
      try {
        ({ body } = await ctx.client.get(e.url));
      } catch (err) {
        if (!(err instanceof WebsiteClientError)) throw err;
        unavailable++;
        return { ...e, description: undefined };
      }
      const parsed = parsePage(body);
      return { ...e, description: parsed.description || parsed.title };
    }),
  );
  let note: string | undefined;
  if (unavailable > 0 && unavailable === entries.length) {
    note =
      "Note: descriptions could not be fetched (the site could not be reached); labels and URLs are from the verified catalog.";
  } else if (unavailable > 0) {
    note = `Note: ${unavailable} of ${entries.length} descriptions could not be fetched.`;
  }
  return { entries: out, unavailable, note };
}

/** Structured fields describing description availability. */
function enrichFields(e: Enriched): Record<string, unknown> {
  if (e.unavailable === undefined) return {};
  return {
    descriptions_unavailable: e.unavailable,
    ...(e.note ? { note: e.note } : {}),
  };
}

function render(
  title: string,
  entries: CatalogEntry[],
  structured: Record<string, unknown>,
  note?: string,
): ReturnType<typeof buildResult> {
  const lines = [`# ${title}`, ""];
  if (note) lines.push(note, "");
  for (const e of entries) {
    lines.push(`## ${e.label}`);
    lines.push(`- URL: ${e.url}`);
    if (e.description) lines.push(`- ${e.description}`);
    lines.push("");
  }
  return buildResult(lines.join("\n"), structured);
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

The feature areas are fixed site sections (for example Fee management, Admissions, Attendance, Communication and Reports). Use raivatedu_get_page_content on a returned URL for the full write-up of a feature.

Args:
  - market (optional): locale for the URLs (${MARKETS.join(", ")}); defaults to the configured market.
  - include_descriptions (boolean): fetch each feature page's summary (default false).`,
      inputSchema: {
        market: marketField,
        include_descriptions: includeDescriptionsField,
        response_format: responseFormatField,
      },
      outputSchema: featuresOutput,
      annotations: READONLY,
    },
    async ({ market, include_descriptions }) => {
      try {
        const m: Market = market ?? ctx.config.defaultMarket;
        const base: CatalogEntry[] = FEATURE_SLUGS.map((slug) => ({
          slug,
          label: FEATURE_LABELS[slug],
          url: `${SITE_ORIGIN}/${m}/features/${slug}`,
        }));
        const enriched = await enrich(ctx, base, include_descriptions);
        const features = tagged(enriched.entries, "raivatedu_list_features");
        const structured = {
          market: m,
          count: features.length,
          features,
          ...enrichFields(enriched),
        };
        return render(
          `RaivatEdu features (${m.toUpperCase()})`,
          features,
          structured,
          enriched.note,
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

The segments include Schools, Colleges & Universities, Coaching Institutes, and Training & EdTech. Use raivatedu_get_page_content on a returned URL for the full pitch tailored to that segment.

Args:
  - market (optional): locale for the URLs (${MARKETS.join(", ")}); defaults to the configured market.
  - include_descriptions (boolean): fetch each solution page's summary (default false).`,
      inputSchema: {
        market: marketField,
        include_descriptions: includeDescriptionsField,
        response_format: responseFormatField,
      },
      outputSchema: solutionsOutput,
      annotations: READONLY,
    },
    async ({ market, include_descriptions }) => {
      try {
        const m: Market = market ?? ctx.config.defaultMarket;
        const base: CatalogEntry[] = SOLUTION_SLUGS.map((slug) => ({
          slug,
          label: SOLUTION_LABELS[slug],
          url: `${SITE_ORIGIN}/${m}/solutions/${slug}`,
        }));
        const enriched = await enrich(ctx, base, include_descriptions);
        const solutions = tagged(enriched.entries, "raivatedu_list_solutions");
        const structured = {
          market: m,
          count: solutions.length,
          solutions,
          ...enrichFields(enriched),
        };
        return render(
          `RaivatEdu solutions (${m.toUpperCase()})`,
          solutions,
          structured,
          enriched.note,
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
  - include_descriptions (boolean): fetch each article's summary (default false).`,
      inputSchema: {
        market: marketField,
        include_descriptions: includeDescriptionsField,
        response_format: responseFormatField,
      },
      outputSchema: resourcesOutput,
      annotations: READONLY,
    },
    async ({ market, include_descriptions }) => {
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
        const enriched = await enrich(ctx, base, include_descriptions);
        const articles = tagged(enriched.entries, "raivatedu_list_resources");
        const landing = (path: string) =>
          withUtm(`${SITE_ORIGIN}/${m}/${path}`, "raivatedu_list_resources");
        const landing_pages = {
          resources: landing("resources"),
          blog: landing("blog"),
          guides: landing("guides"),
          help: landing("help"),
        };
        const structured = {
          market: m,
          landing_pages,
          count: articles.length,
          articles,
          ...enrichFields(enriched),
        };

        const lines = [
          `# RaivatEdu resources (${m.toUpperCase()})`,
          "",
          ...(enriched.note ? [enriched.note, ""] : []),
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
        return buildResult(lines.join("\n"), structured);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
