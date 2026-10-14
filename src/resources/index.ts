/**
 * Read-only MCP resources exposing verified public RaivatEdu data by URI:
 *   raivatedu://info               – product/organization/markets overview
 *   raivatedu://contact            – published contact details
 *   raivatedu://pages/{market}     – page catalog for a market
 *   raivatedu://pricing/{market}   – pricing plans for a market
 */

import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { SITE_ORIGIN, MARKETS, MARKET_INFO, type Market } from "../config.js";
import { CATALOG } from "../utils/url.js";
import { isValidMarket } from "../utils/url.js";
import {
  extractOrganization,
  extractPricing,
  extractSoftware,
  offersCurrency,
  parsePage,
} from "../services/content-parser.js";
import { withUtm } from "../utils/utm.js";

function jsonContents(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function marketParam(value: string | string[] | undefined): Market {
  const raw = (Array.isArray(value) ? value[0] ?? "" : value ?? "").toLowerCase();
  if (!isValidMarket(raw)) {
    throw new Error(
      `Unknown market "${raw}". Valid markets: ${MARKETS.join(", ")}.`,
    );
  }
  return raw;
}

export function registerResources(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "raivatedu-info",
    "raivatedu://info",
    {
      title: "RaivatEdu website info",
      description:
        "Verified product, organization and market overview from the site's JSON-LD.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { body } = await ctx.client.get(`${SITE_ORIGIN}/${ctx.config.defaultMarket}`);
      const parsed = parsePage(body);
      return jsonContents(uri, {
        product: extractSoftware(parsed.jsonLd),
        organization: extractOrganization(parsed.jsonLd),
        markets: MARKETS.map((code) => ({
          code,
          name: MARKET_INFO[code].name,
          currency: MARKET_INFO[code].currency,
          url: withUtm(`${SITE_ORIGIN}/${code}`, "raivatedu-info"),
        })),
      });
    },
  );

  server.registerResource(
    "raivatedu-contact",
    "raivatedu://contact",
    {
      title: "RaivatEdu contact information",
      description: "Published sales/support/security email contact points.",
      mimeType: "application/json",
    },
    async (uri) => {
      const m = ctx.config.defaultMarket;
      const { body } = await ctx.client.get(`${SITE_ORIGIN}/${m}`);
      const org = extractOrganization(parsePage(body).jsonLd);
      return jsonContents(uri, {
        general_email: org?.email ?? null,
        contact_points: org?.contactPoints ?? [],
        contact_page: withUtm(`${SITE_ORIGIN}/${m}/contact`, "raivatedu-contact"),
        demo_page: withUtm(`${SITE_ORIGIN}/${m}/demo`, "raivatedu-contact"),
      });
    },
  );

  const marketList = async () => ({
    resources: MARKETS.map((code) => ({
      uri: `raivatedu://pages/${code}`,
      name: `pages-${code}`,
      description: `Page catalog for ${MARKET_INFO[code].name}`,
      mimeType: "application/json",
    })),
  });

  server.registerResource(
    "raivatedu-pages",
    new ResourceTemplate("raivatedu://pages/{market}", { list: marketList }),
    {
      title: "RaivatEdu page catalog",
      description: "All public page paths for a given market.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const m = marketParam(variables.market);
      const pages = CATALOG.filter((p) => p.market === m || p.market === null);
      return jsonContents(uri, {
        market: m,
        count: pages.length,
        pages: pages.map((p) => ({
          path: p.path,
          url: withUtm(p.url, "raivatedu-pages"),
          type: p.type,
        })),
      });
    },
  );

  server.registerResource(
    "raivatedu-pricing",
    new ResourceTemplate("raivatedu://pricing/{market}", {
      list: async () => ({
        resources: MARKETS.map((code) => ({
          uri: `raivatedu://pricing/${code}`,
          name: `pricing-${code}`,
          description: `Pricing for ${MARKET_INFO[code].name} (${MARKET_INFO[code].currency})`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "RaivatEdu pricing",
      description: "Subscription plans and prices for a given market.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const m = marketParam(variables.market);
      const { body } = await ctx.client.get(`${SITE_ORIGIN}/${m}/pricing`);
      const plans = extractPricing(parsePage(body).jsonLd);
      return jsonContents(uri, {
        market: m,
        // The offers' own priceCurrency; the market map only as a fallback.
        currency: offersCurrency(plans) ?? MARKET_INFO[m].currency,
        plans,
      });
    },
  );
}
