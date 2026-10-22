import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { HOME_HTML } from "./fixtures.js";

const FEATURE_HTML = `<!doctype html><html><head>
  <title>Admissions Software | RaivatEdu</title>
  <meta name="description" content="Track every enquiry through a pipeline." />
</head><body><main><h1>From enquiry to student</h1>
<p>WhatsApp follow-ups and admissions pipeline for coaching institutes.</p></main></body></html>`;

/** Route mocked fetch by method + URL to a fixture. */
function installFetchMock() {
  const mock = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (/\/features\//.test(url)) {
      return new Response(FEATURE_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    // Home + pricing + everything else: the fixture that carries JSON-LD offers.
    return new Response(HOME_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function makeClient() {
  const { server } = createServer(
    loadConfig({ RAIVATEDU_MIN_REQUEST_INTERVAL_MS: "0", RAIVATEDU_LOG_LEVEL: "silent" }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("tool discovery", () => {
  beforeEach(() => installFetchMock());
  afterEach(() => vi.restoreAllMocks());

  it("exposes all thirteen tools with annotations and schemas", async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "raivatedu_check_website_status",
        "raivatedu_find_page_for_need",
        "raivatedu_get_contact_information",
        "raivatedu_get_limits",
        "raivatedu_get_page_content",
        "raivatedu_get_pricing",
        "raivatedu_get_started",
        "raivatedu_get_website_info",
        "raivatedu_list_features",
        "raivatedu_list_pages",
        "raivatedu_list_resources",
        "raivatedu_list_solutions",
        "raivatedu_search_content",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description && t.description.length).toBeTruthy();
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.outputSchema?.type).toBe("object");
      expect(t.description).not.toMatch(/Returns JSON shape/);
    }
  });

  it("registers resources, templates and prompts", async () => {
    const { client } = await makeClient();
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(
      ["check_capability", "compare_plans", "explain_education_term", "find_relevant_plan", "navigate_website", "plan_admissions_workflow", "summarize_page"],
    );
    const templates = (await client.listResourceTemplates()).resourceTemplates;
    expect(templates.map((t) => t.uriTemplate)).toContain("raivatedu://pricing/{market}");
  });
});

describe("tool behaviour (mocked HTTP)", () => {
  beforeEach(() => installFetchMock());
  afterEach(() => vi.restoreAllMocks());

  it("get_pricing returns structured plans", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_get_pricing",
      arguments: { market: "in", response_format: "json" },
    });
    const data = res.structuredContent as any;
    expect(data.plans).toHaveLength(3);
    expect(data.plans[0].price).toBe(3500);
    expect(data.currency).toBe("INR");
  });

  it("check_website_status reports reachable", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_check_website_status",
      arguments: {},
    });
    expect((res.structuredContent as any).reachable).toBe(true);
    expect((res.structuredContent as any).status).toBe(200);
  });

  it("get_website_info reads org + software + markets", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_get_website_info",
      arguments: { response_format: "json" },
    });
    const data = res.structuredContent as any;
    expect(data.organization.email).toBe("hello@raivatedu.com");
    expect(data.product.name).toBe("RaivatEdu");
    expect(data.markets).toHaveLength(10);
  });

  it("get_contact_information returns contact points", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_get_contact_information",
      arguments: { response_format: "json" },
    });
    const data = res.structuredContent as any;
    expect(data.general_email).toBe("hello@raivatedu.com");
    expect(data.contact_points.map((c: any) => c.type)).toContain("sales");
  });

  it("list_pages filters by type and needs no network", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_list_pages",
      arguments: { market: "in", type: "feature", response_format: "json" },
    });
    const data = res.structuredContent as any;
    expect(data.count).toBe(9);
    expect(data.pages.every((p: any) => p.type === "feature")).toBe(true);
  });

  it("get_page_content returns a known feature page", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_get_page_content",
      arguments: { path: "/in/features/admissions", response_format: "json" },
    });
    const data = res.structuredContent as any;
    expect(data.title).toContain("Admissions");
    expect(data.text).toContain("admissions pipeline");
  });

  it("get_page_content rejects an unknown path", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_get_page_content",
      arguments: { path: "/in/does-not-exist" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toMatch(/not a known public/);
  });

  it("get_page_content rejects an external host (SSRF)", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_get_page_content",
      arguments: { path: "https://evil.example.com/" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toMatch(/only reads pages on/);
  });

  it("search_content ranks matching pages and returns snippets", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_search_content",
      arguments: { query: "whatsapp", market: "in", limit: 5, response_format: "json" },
    });
    const data = res.structuredContent as any;
    expect(data.count).toBeGreaterThan(0);
    expect(data.results[0].score).toBeGreaterThan(0);
  });

  it("search_content returns empty results (not an error) for no match", async () => {
    const { client } = await makeClient();
    const res = await client.callTool({
      name: "raivatedu_search_content",
      arguments: { query: "zzzxqwvnomatch", market: "in", response_format: "json" },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as any).count).toBe(0);
  });

  it("rejects invalid input (bad market enum)", async () => {
    const { client } = await makeClient();
    let threwOrErrored = false;
    try {
      const res = await client.callTool({
        name: "raivatedu_get_pricing",
        arguments: { market: "xx" },
      });
      threwOrErrored = res.isError === true;
    } catch {
      threwOrErrored = true;
    }
    expect(threwOrErrored).toBe(true);
  });
});
