/**
 * Optional live smoke tests that hit the real raivatedu.com.
 * Skipped unless RUN_SMOKE=1, so the default `npm test` stays offline.
 *
 *   RUN_SMOKE=1 npm test
 */
import { describe, it, expect } from "vitest";
import { WebsiteClient } from "../src/services/website-client.js";
import { loadConfig, SITE_ORIGIN } from "../src/config.js";
import { createLogger } from "../src/utils/logger.js";
import { extractPricing, parsePage } from "../src/services/content-parser.js";

const run = process.env.RUN_SMOKE === "1";

describe.skipIf(!run)("live smoke tests", () => {
  const client = new WebsiteClient(loadConfig({}), createLogger({ logLevel: "silent" }));

  it("the India home page is reachable", async () => {
    const res = await client.head(`${SITE_ORIGIN}/in`);
    expect(res.ok).toBe(true);
  });

  it("the India pricing page exposes JSON-LD offers", async () => {
    const { body } = await client.get(`${SITE_ORIGIN}/in/pricing`);
    const plans = extractPricing(parsePage(body).jsonLd);
    expect(plans.length).toBeGreaterThanOrEqual(3);
    expect(plans.some((p) => p.currency === "INR")).toBe(true);
  });
});
