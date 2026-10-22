import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { RULES, matchRules } from "../src/tools/recommend.js";
import { lookupPath } from "../src/utils/url.js";

async function connect() {
  const { server } = createServer(
    loadConfig({ RAIVATEDU_MIN_REQUEST_INTERVAL_MS: "0", RAIVATEDU_LOG_LEVEL: "silent" }),
  );
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(c);
  return client;
}

type Out = {
  matches: { topic: string; pages: { path: string; url: string }[] }[];
  fallback_pages: { path: string }[];
  check_limits_first: boolean;
};

describe("rules", () => {
  it("every rule path exists in the page catalog for every market", () => {
    for (const market of ["in", "us", "gb", "au", "sg"]) {
      for (const r of RULES) {
        for (const rel of r.paths) {
          expect(lookupPath(`/${market}/${rel}`), `${market}/${rel}`).toBeDefined();
        }
      }
    }
  });

  it("routes the researched intents to their owner pages", () => {
    expect(matchRules("school management software").map((r) => r.paths[0])).toContain(
      "school-management-software",
    );
    expect(matchRules("admission management software for a college").map((r) => r.paths[0])).toContain(
      "admission-management-software",
    );
    expect(matchRules("student management system").map((r) => r.paths[0])).toContain(
      "student-management-system",
    );
    expect(matchRules("school fee management software").map((r) => r.paths[0])).toContain(
      "features/fee-management",
    );
  });
});

describe("raivatedu_find_page_for_need", () => {
  it("returns market-prefixed, UTM-tagged canonical URLs", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "raivatedu_find_page_for_need",
      arguments: { need: "fee management for a coaching institute", market: "in" },
    });
    expect(res.isError).toBeFalsy();
    const d = res.structuredContent as unknown as Out;
    const urls = d.matches.flatMap((m) => m.pages.map((p) => p.url));
    expect(urls).toContain(
      "https://www.raivatedu.com/in/features/fee-management?utm_source=mcp&utm_medium=ai_agent&utm_campaign=raivatedu_find_page_for_need",
    );
    expect(d.check_limits_first).toBe(false);
  });

  it("flags questions about things the site lists as not built", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "raivatedu_find_page_for_need",
      arguments: { need: "do you have a parent portal and report cards" },
    });
    expect((res.structuredContent as unknown as Out).check_limits_first).toBe(true);
  });

  it("falls back to the overview pages when nothing matches", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "raivatedu_find_page_for_need",
      arguments: { need: "zzzz qqqq", market: "us" },
    });
    const d = res.structuredContent as unknown as Out;
    expect(d.matches).toHaveLength(0);
    expect(d.fallback_pages.map((p) => p.path)).toEqual(["/us/features", "/us/solutions"]);
  });
});
