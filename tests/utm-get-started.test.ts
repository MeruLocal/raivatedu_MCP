import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { withUtm } from "../src/utils/utm.js";
import { extractTrialTerms, offersCurrency } from "../src/services/content-parser.js";
import { FAQ_HTML, HOME_HTML } from "./fixtures.js";

/** Pricing page with offers in INR plus an FAQ about the free trial. */
const PRICING_WITH_FAQ = HOME_HTML.replace(
  "</head>",
  FAQ_HTML.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/)![0] + "</head>",
);

let pricingHtml = HOME_HTML;

function installFetchMock() {
  const mock = vi.fn(async (url: string, init?: { method?: string }) => {
    if ((init?.method ?? "GET") === "HEAD") return new Response(null, { status: 200 });
    const body = /\/pricing$/.test(url) ? pricingHtml : HOME_HTML;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function makeClient() {
  const { server } = createServer(
    loadConfig({ RAIVATEDU_MIN_REQUEST_INTERVAL_MS: "0", RAIVATEDU_LOG_LEVEL: "silent" }),
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
  return client;
}

const text = (res: { content?: unknown }) =>
  ((res.content as { text: string }[])[0] ?? { text: "" }).text;

beforeEach(() => {
  pricingHtml = HOME_HTML;
  installFetchMock();
});
afterEach(() => vi.unstubAllGlobals());

describe("withUtm", () => {
  it("tags an own-site URL", () => {
    expect(withUtm("https://www.raivatedu.com/in/demo", "t")).toBe(
      "https://www.raivatedu.com/in/demo?utm_source=mcp&utm_medium=ai_agent&utm_campaign=t",
    );
  });
  it("keeps an existing query and #hash", () => {
    const u = new URL(withUtm("https://raivatedu.com/in/pricing?plan=pro#faq", "t"));
    expect(u.searchParams.get("plan")).toBe("pro");
    expect(u.searchParams.get("utm_campaign")).toBe("t");
    expect(u.hash).toBe("#faq");
  });
  it("never overwrites an existing utm_source", () => {
    const u = new URL(withUtm("https://www.raivatedu.com/in?utm_source=newsletter", "t"));
    expect(u.searchParams.get("utm_source")).toBe("newsletter");
    expect(u.searchParams.get("utm_medium")).toBe("ai_agent");
  });
  it("leaves external URLs untouched", () => {
    expect(withUtm("https://external.example.com/x", "t")).toBe("https://external.example.com/x");
  });
});

describe("raivatedu_get_started", () => {
  it("returns tagged demo, contact and pricing URLs and no signup URL", async () => {
    const f = installFetchMock();
    const client = await makeClient();
    const res = await client.callTool({ name: "raivatedu_get_started", arguments: { market: "us" } });
    const d = res.structuredContent as Record<string, string | null>;
    expect(d.demo_url).toBe(
      "https://www.raivatedu.com/us/demo?utm_source=mcp&utm_medium=ai_agent&utm_campaign=raivatedu_get_started",
    );
    expect(d.contact_url).toContain("/us/contact?utm_source=mcp");
    expect(d.pricing_url).toContain("/us/pricing?utm_source=mcp");
    expect(d.signup_url).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("never mentions a trial anywhere in its output", async () => {
    installFetchMock();
    const client = await makeClient();
    const res = await client.callTool({ name: "raivatedu_get_started", arguments: { market: "us" } });
    expect(JSON.stringify(res)).not.toMatch(/trial/i);
    expect((res.structuredContent as { call_to_action: string }).call_to_action).toBe(
      "Book a demo or contact sales.",
    );
  });
});

describe("UTM tags in tool output", () => {
  it("list_pages URLs are tagged and a tagged URL is accepted by get_page_content", async () => {
    const client = await makeClient();
    const list = await client.callTool({
      name: "raivatedu_list_pages",
      arguments: { market: "in", type: "pricing" },
    });
    const url = (list.structuredContent as { pages: { url: string }[] }).pages[0]!.url;
    expect(url).toContain("utm_source=mcp");
    const page = await client.callTool({ name: "raivatedu_get_page_content", arguments: { path: url } });
    expect(page.isError).toBeFalsy();
  });

  it("source_url stays untagged", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "raivatedu_get_pricing", arguments: { market: "in" } });
    expect((res.structuredContent as { source_url: string }).source_url).toBe(
      "https://www.raivatedu.com/in/pricing",
    );
  });
});

describe("trial terms and currency", () => {
  it("does not assert a 14-day trial when the page does not say so", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "raivatedu_get_pricing", arguments: { market: "in" } });
    expect(text(res)).not.toMatch(/14-day/);
    expect(text(res)).toMatch(/Trial terms: see the pricing page/);
    expect((res.structuredContent as { trial_terms: unknown }).trial_terms).toBeNull();
  });

  it("uses the FAQ's trial text when the page publishes it", async () => {
    pricingHtml = PRICING_WITH_FAQ;
    const client = await makeClient();
    const res = await client.callTool({ name: "raivatedu_get_pricing", arguments: { market: "in" } });
    expect(text(res)).toContain("Yes, 14 days with no credit card.");
    expect((res.structuredContent as { trial_terms: unknown }).trial_terms).toEqual({
      text: "Yes, 14 days with no credit card.",
      source: "faq",
    });
  });

  it("keeps the published prices unchanged", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "raivatedu_get_pricing", arguments: { market: "in" } });
    const plans = (res.structuredContent as { plans: { price: number }[] }).plans;
    expect(plans.map((p) => p.price)).toEqual([3500, 4500, 8000]);
  });

  it("takes currency from the offers, not the market map", async () => {
    // The fixture's offers are in INR; asking for the US market must report
    // what the page publishes, in the tool and the resource alike.
    const client = await makeClient();
    const res = await client.callTool({ name: "raivatedu_get_pricing", arguments: { market: "us" } });
    expect((res.structuredContent as { currency: string }).currency).toBe("INR");
    const r = await client.readResource({ uri: "raivatedu://pricing/us" });
    expect(JSON.parse((r.contents[0] as { text: string }).text).currency).toBe("INR");
  });

  it("falls back to the market map with no or disagreeing offers", () => {
    expect(offersCurrency([])).toBeUndefined();
    const offer = { plan: "a", billing: "", price: 1, unit: "" };
    expect(
      offersCurrency([
        { ...offer, currency: "INR" },
        { ...offer, currency: "USD" },
      ]),
    ).toBeUndefined();
  });

  it("reads trial terms from an Offer description", () => {
    const terms = extractTrialTerms([
      {
        "@type": "SoftwareApplication",
        offers: [{ "@type": "Offer", price: 0, description: "Free trial for 30 days" }],
      },
    ]);
    expect(terms).toEqual({ text: "Free trial for 30 days", source: "json-ld" });
  });
});

describe("prompts", () => {
  it("never assert a free trial unconditionally", async () => {
    const client = await makeClient();
    for (const name of ["find_relevant_plan", "compare_plans"]) {
      const p = await client.getPrompt({
        name,
        arguments: name === "find_relevant_plan" ? { institution_type: "school" } : {},
      });
      const t = (p.messages[0]!.content as { text: string }).text;
      expect(t).not.toMatch(/14-day/);
      expect(t).not.toMatch(/(?<!any )free trial(?! terms)/i);
    }
  });
});

describe("output schemas", () => {
  it("initialize returns serverInfo.websiteUrl", async () => {
    const client = await makeClient();
    expect(client.getServerVersion()?.websiteUrl).toBe("https://www.raivatedu.com");
  });

  it("a structuredContent that does not match its outputSchema is rejected", async () => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool(
      "bad",
      { description: "returns the wrong shape", outputSchema: { n: z.number() } },
      async () => ({ content: [{ type: "text", text: "x" }], structuredContent: { n: "nope" } }),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(ct);
    let failed = false;
    try {
      const res = await client.callTool({ name: "bad", arguments: {} });
      failed = res.isError === true;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it("text content is markdown even when response_format json is passed", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_list_pages",
      arguments: { market: "in", type: "pricing", response_format: "json" },
    });
    expect(text(res).startsWith("# RaivatEdu pages")).toBe(true);
  });
});
