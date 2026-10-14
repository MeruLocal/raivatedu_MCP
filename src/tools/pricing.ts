/** Tool: get_pricing — pricing plans for a market, from JSON-LD offers. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { SITE_ORIGIN, MARKETS, MARKET_INFO } from "../config.js";
import { toToolError } from "../utils/errors.js";
import { extractPricing, parsePage } from "../services/content-parser.js";
import {
  buildResult,
  marketField,
  mdCell,
  responseFormatField,
} from "./shared.js";

export function registerPricingTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  server.registerTool(
    "raivatedu_get_pricing",
    {
      title: "Get RaivatEdu Pricing",
      description: `Retrieve RaivatEdu's subscription plans and prices for a given market.

Prices are read from the schema.org pricing Offers embedded in the market's /pricing page JSON-LD, so currency and amounts are exactly as published (e.g. India: Starter, Professional, Enterprise priced per user per month in INR). A 14-day free trial is offered on all plans.

Args:
  - market (optional): locale to price (${MARKETS.join(", ")}); defaults to the configured market. Each market prices in its local currency.
  - response_format ('markdown' | 'json'): output format (default markdown).

Returns JSON shape:
  {
    "market": string,
    "currency": string,
    "plans": [ { "plan", "billing", "price": number, "currency", "unit", "minUsers"?, "maxUsers"?, "url"? } ],
    "source_url": string
  }

Notes:
  - Amounts are numeric (e.g. 3500), not pre-formatted strings.
  - "Enterprise" typically has no maxUsers (open-ended) and may also be quoted via sales.`,
      inputSchema: { market: marketField, response_format: responseFormatField },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ market, response_format }) => {
      try {
        const m = market ?? ctx.config.defaultMarket;
        const url = `${SITE_ORIGIN}/${m}/pricing`;
        const { body } = await ctx.client.get(url);
        const parsed = parsePage(body);
        const plans = extractPricing(parsed.jsonLd);

        const structured = {
          market: m,
          currency: MARKET_INFO[m].currency,
          plans,
          source_url: url,
        };

        if (plans.length === 0) {
          return buildResult(
            `No machine-readable pricing offers were found on ${url}. The page may present pricing differently for this market; open it in a browser to confirm.`,
            structured,
            response_format,
          );
        }

        const header = `# RaivatEdu pricing — ${MARKET_INFO[m].name} (${m.toUpperCase()})`;
        const table = [
          "| Plan | Price | Unit | Users | Billing |",
          "| --- | --- | --- | --- | --- |",
          ...plans.map((p) => {
            const users =
              p.minUsers !== undefined
                ? p.maxUsers !== undefined
                  ? `${p.minUsers}–${p.maxUsers}`
                  : `${p.minUsers}+`
                : "—";
            return `| ${mdCell(p.plan)} | ${mdCell(p.price)} ${mdCell(p.currency)} | ${mdCell(p.unit)} | ${users} | ${mdCell(p.billing)} |`;
          }),
        ].join("\n");

        const text = [
          header,
          "",
          table,
          "",
          "_All plans include a 14-day free trial (no credit card required). Source: " +
            url +
            "_",
        ].join("\n");

        return buildResult(text, structured, response_format);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
