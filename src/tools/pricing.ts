/** Tool: get_pricing — pricing plans for a market, from JSON-LD offers. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { SITE_ORIGIN, MARKETS, MARKET_INFO } from "../config.js";
import { toToolError } from "../utils/errors.js";
import {
  extractPricing,
  extractTrialTerms,
  offersCurrency,
  parsePage,
} from "../services/content-parser.js";
import {
  buildResult,
  marketField,
  mdCell,
  responseFormatField,
} from "./shared.js";
import { withUtm } from "../utils/utm.js";
import { pricingOutput } from "./schemas.js";

export function registerPricingTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  server.registerTool(
    "raivatedu_get_pricing",
    {
      title: "Get RaivatEdu Pricing",
      description: `Retrieve RaivatEdu's subscription plans and prices for a given market.

Prices are read from the schema.org pricing Offers embedded in the market's /pricing page JSON-LD, so currency and amounts are exactly as published (e.g. India: Starter, Professional, Enterprise priced per user per month in INR). Free-trial terms are reported only when the page's structured data states them (trial_terms); otherwise the result points to the pricing page.

Args:
  - market (optional): locale to price (${MARKETS.join(", ")}); defaults to the configured market. Each market prices in its local currency.

Notes:
  - Amounts are numeric (e.g. 3500), not pre-formatted strings.
  - "Enterprise" typically has no maxUsers (open-ended) and may also be quoted via sales.`,
      inputSchema: { market: marketField, response_format: responseFormatField },
      outputSchema: pricingOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ market }) => {
      try {
        const m = market ?? ctx.config.defaultMarket;
        const url = `${SITE_ORIGIN}/${m}/pricing`;
        const { body } = await ctx.client.get(url);
        const parsed = parsePage(body);
        const plans = extractPricing(parsed.jsonLd).map((p) =>
          p.url ? { ...p, url: withUtm(p.url, "raivatedu_get_pricing") } : p,
        );
        const trial = extractTrialTerms(parsed.jsonLd);
        const currency = offersCurrency(plans) ?? MARKET_INFO[m].currency;

        const structured = {
          market: m,
          currency,
          plans,
          trial_terms: trial,
          source_url: url,
        };

        if (plans.length === 0) {
          return buildResult(
            `No machine-readable pricing offers were found on ${url}. The page may present pricing differently for this market; open it in a browser to confirm.`,
            structured,
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

        const pricingLink = withUtm(url, "raivatedu_get_pricing");
        const trialLine = trial
          ? `_Trial terms (from the page's ${trial.source === "faq" ? "FAQ" : "structured data"}): ${trial.text}_`
          : `_Trial terms: see the pricing page: ${pricingLink}_`;

        const text = [header, "", table, "", trialLine, "", `_Source: ${url}_`].join("\n");

        return buildResult(text, structured);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
