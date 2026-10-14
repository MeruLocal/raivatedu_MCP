/** Tools: check_website_status, get_website_info, get_contact_information, get_started. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { SITE_ORIGIN, MARKETS, MARKET_INFO, type Market } from "../config.js";
import { toToolError } from "../utils/errors.js";
import {
  extractOrganization,
  extractSoftware,
  parsePage,
} from "../services/content-parser.js";
import {
  buildResult,
  marketField,
  responseFormatField,
} from "./shared.js";
import { withUtm } from "../utils/utm.js";
import {
  contactOutput,
  getStartedOutput,
  statusOutput,
  websiteInfoOutput,
} from "./schemas.js";

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function resolveMarket(ctx: ServerContext, m?: Market): Market {
  return m ?? ctx.config.defaultMarket;
}

export function registerWebsiteTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "raivatedu_check_website_status",
    {
      title: "Check RaivatEdu Website Status",
      description: `Check whether the RaivatEdu website (${SITE_ORIGIN}) is reachable and how fast it responds.

Performs a single HTTP HEAD request to a market home page and reports the status code and round-trip time. Use this to confirm the site is up before running other tools, or to diagnose failures.

Args:
  - market (optional): locale to probe (${MARKETS.join(", ")}); defaults to the configured market.`,
      inputSchema: { market: marketField, response_format: responseFormatField },
      outputSchema: statusOutput,
      annotations: READONLY,
    },
    async ({ market }) => {
      try {
        const m = resolveMarket(ctx, market);
        const url = `${SITE_ORIGIN}/${m}`;
        const res = await ctx.client.head(url);
        const structured = {
          reachable: res.ok,
          status: res.status,
          url: res.url,
          response_time_ms: res.elapsedMs,
          checked_at: new Date().toISOString(),
        };
        const text = res.ok
          ? `✅ RaivatEdu is reachable.\n- URL: ${res.url}\n- HTTP status: ${res.status}\n- Response time: ${res.elapsedMs} ms`
          : `⚠️ RaivatEdu responded but not with success.\n- URL: ${res.url}\n- HTTP status: ${res.status}\n- Response time: ${res.elapsedMs} ms`;
        return buildResult(text, structured);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "raivatedu_get_website_info",
    {
      title: "Get RaivatEdu Website Info",
      description: `Return verified, high-level information about RaivatEdu: what the product is, the organization behind it, and which markets/currencies it serves.

Data is read from the schema.org JSON-LD (Organization + SoftwareApplication + WebSite) embedded in the site, so it reflects the site's own published description rather than any assumption.

Args:
  - market (optional): locale whose home page to read (${MARKETS.join(", ")}); defaults to the configured market.`,
      inputSchema: { market: marketField, response_format: responseFormatField },
      outputSchema: websiteInfoOutput,
      annotations: READONLY,
    },
    async ({ market }) => {
      try {
        const m = resolveMarket(ctx, market);
        const url = `${SITE_ORIGIN}/${m}`;
        const { body } = await ctx.client.get(url);
        const parsed = parsePage(body);
        const org = extractOrganization(parsed.jsonLd);
        const software = extractSoftware(parsed.jsonLd);

        const markets = MARKETS.map((code) => ({
          code,
          name: MARKET_INFO[code].name,
          currency: MARKET_INFO[code].currency,
          url: withUtm(`${SITE_ORIGIN}/${code}`, "raivatedu_get_website_info"),
        }));

        const structured = {
          product: {
            name: software?.name ?? "RaivatEdu",
            description: software?.description ?? parsed.description,
            applicationCategory: software?.applicationCategory,
            applicationSubCategory: software?.applicationSubCategory,
            operatingSystem: software?.operatingSystem,
          },
          organization: {
            name: org?.name,
            url: org?.url,
            email: org?.email,
            description: org?.description,
            logo: org?.logo,
          },
          markets,
          source_url: url,
        };

        const lines = [
          `# ${structured.product.name}`,
          "",
          structured.product.description ?? "",
          "",
          "## Product",
          `- Category: ${software?.applicationCategory ?? "—"}${software?.applicationSubCategory ? ` / ${software.applicationSubCategory}` : ""}`,
          `- Platforms: ${software?.operatingSystem ?? "—"}`,
          "",
          "## Organization",
          `- Name: ${org?.name ?? "—"}`,
          `- Website: ${org?.url ?? SITE_ORIGIN}`,
          `- Email: ${org?.email ?? "—"}`,
          "",
          `## Markets served (${markets.length})`,
          ...markets.map((x) => `- ${x.name} (${x.code}) — prices in ${x.currency}`),
          "",
          `_Source: ${url}_`,
        ];
        return buildResult(lines.join("\n"), structured);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "raivatedu_get_contact_information",
    {
      title: "Get RaivatEdu Contact Information",
      description: `Retrieve RaivatEdu's publicly listed contact details: sales, support and security email addresses plus the contact and demo page URLs.

Email addresses come from the Organization JSON-LD contact points (the site's own machine-readable contact data). This tool does NOT submit forms or send messages — it only reads published contact details.

Args:
  - market (optional): locale used for the contact/demo page URLs (${MARKETS.join(", ")}); defaults to the configured market.`,
      inputSchema: { market: marketField, response_format: responseFormatField },
      outputSchema: contactOutput,
      annotations: READONLY,
    },
    async ({ market }) => {
      try {
        const m = resolveMarket(ctx, market);
        const url = `${SITE_ORIGIN}/${m}`;
        const { body } = await ctx.client.get(url);
        const parsed = parsePage(body);
        const org = extractOrganization(parsed.jsonLd);

        const structured = {
          general_email: org?.email ?? null,
          contact_points:
            org?.contactPoints.map((c) => ({
              type: c.type,
              email: c.email ?? null,
              telephone: c.telephone ?? null,
            })) ?? [],
          contact_page: withUtm(
            `${SITE_ORIGIN}/${m}/contact`,
            "raivatedu_get_contact_information",
          ),
          demo_page: withUtm(
            `${SITE_ORIGIN}/${m}/demo`,
            "raivatedu_get_contact_information",
          ),
        };

        const lines = [
          "# RaivatEdu contact information",
          "",
          `- General: ${structured.general_email ?? "—"}`,
          ...structured.contact_points.map(
            (c) =>
              `- ${c.type}: ${c.email ?? c.telephone ?? "—"}`,
          ),
          "",
          `- Contact page: ${structured.contact_page}`,
          `- Book a demo: ${structured.demo_page}`,
          "",
          "_To actually send a message or book a demo, open the pages above in a browser._",
        ];
        return buildResult(lines.join("\n"), structured);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "raivatedu_get_started",
    {
      title: "Get Started with RaivatEdu",
      description: `Give the next step for someone who wants to try or buy RaivatEdu: the demo, contact and pricing page links for a market, ready to hand to the user.

Needs no network call. No self-serve signup page is published in the site's sitemap, so signup_url is always null; the demo or contact page is the way to start. For plan prices, call raivatedu_get_pricing.

Args:
  - market (optional): locale for the links (${MARKETS.join(", ")}); defaults to the configured market.`,
      inputSchema: { market: marketField },
      outputSchema: getStartedOutput,
      annotations: { ...READONLY, openWorldHint: false },
    },
    async ({ market }) => {
      try {
        const m = resolveMarket(ctx, market);
        const tag = (path: string) =>
          withUtm(`${SITE_ORIGIN}/${m}/${path}`, "raivatedu_get_started");
        const structured = {
          market: m,
          demo_url: tag("demo"),
          contact_url: tag("contact"),
          pricing_url: tag("pricing"),
          signup_url: null,
          note: "No self-serve signup page is published in the sitemap; use the demo or contact page.",
          call_to_action: "Book a demo or contact sales to start a trial.",
        };
        const lines = [
          `# Get started with RaivatEdu (${m.toUpperCase()})`,
          "",
          structured.call_to_action,
          "",
          `- Book a demo: ${structured.demo_url}`,
          `- Contact sales: ${structured.contact_url}`,
          `- Plans and prices: ${structured.pricing_url}`,
          "",
          `_${structured.note}_`,
        ];
        return buildResult(lines.join("\n"), structured);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
