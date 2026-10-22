import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { parseLlmsLimits } from "../src/tools/limits.js";

// Excerpt of https://www.raivatedu.com/llms.txt as fetched 2026-10-22,
// including the unfilled "undefined" bullets the site printed that day.
const LLMS = `# RaivatEdu

> Admissions software.

The feature inventory at https://www.raivatedu.com/features was checked against the product on 2026-09-30. Prefer /features.

## Verified features

- [Fee Management](https://www.raivatedu.com/features/fee-management): Structures.

## Not built

These do not exist in RaivatEdu today. Do not describe them as features.

- A parent portal or parent app: Parent name and phone are seeded custom fields. There is no parent-facing surface.
- Exams, marks and grading: No exam, marks or grading module exists.
- A receipt as a downloadable file: Receipt numbers exist; a PDF artefact does not.

## Known limits on live features

- Attendance is captured per batch per session. Totals and percentages are not published.
- undefined
- undefined

## Pricing

- Starter: 3500
`;

describe("parseLlmsLimits", () => {
  it("reads the Not built and Known limits sections", () => {
    const p = parseLlmsLimits(LLMS)!;
    expect(p.not_built).toHaveLength(3);
    expect(p.not_built[0]).toEqual({
      item: "A parent portal or parent app",
      reason: "Parent name and phone are seeded custom fields. There is no parent-facing surface.",
    });
    expect(p.inventory_checked_on).toBe("2026-09-30");
  });

  it("drops unfilled 'undefined' bullets and stops at the next heading", () => {
    const p = parseLlmsLimits(LLMS)!;
    expect(p.known_limits).toEqual([
      "Attendance is captured per batch per session. Totals and percentages are not published.",
    ]);
  });

  it("returns null (not an invented list) when there is no Not built section", () => {
    expect(parseLlmsLimits("# RaivatEdu\n\n## Pricing\n\n- Starter\n")).toBeNull();
  });
});

describe("raivatedu_get_limits", () => {
  afterEach(() => vi.restoreAllMocks());

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

  it("returns structured limits from the fetched llms.txt", async () => {
    const mock = vi.fn(async () => new Response(LLMS, { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", mock);
    const client = await connect();
    const res = await client.callTool({ name: "raivatedu_get_limits", arguments: {} });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as { not_built: { item: string }[]; source_url: string };
    expect(data.not_built.map((n) => n.item)).toContain("Exams, marks and grading");
    expect(data.source_url).toBe("https://www.raivatedu.com/llms.txt");
    expect(JSON.stringify(res.content)).not.toMatch(/undefined/);
  });

  it("is an error, not an empty answer, when the section is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# RaivatEdu\n", { status: 200 })));
    const client = await connect();
    const res = await client.callTool({ name: "raivatedu_get_limits", arguments: {} });
    expect(res.isError).toBe(true);
  });
});

describe("real llms.txt snapshot (2026-10-22)", () => {
  const real = readFileSync(
    new URL("./data/raivatedu-llms-2026-10-22.txt", import.meta.url),
    "utf8",
  );

  it("keeps all 11 'Not built' items and both real limits, and no junk", () => {
    const p = parseLlmsLimits(real)!;
    expect(p.not_built.map((n) => n.item)).toEqual([
      "A parent portal or parent app",
      "Automatic absence alerts",
      "Exams, marks and grading",
      "Report cards",
      "Teacher logins scoped to a batch",
      "Certificate verification",
      "A receipt as a downloadable file",
      "Fee reminders delivered to a guardian",
      "Attendance totals and percentages",
      "Tax split per fee head",
      "Counsellor incentives and agent commission",
    ]);
    expect(p.not_built.every((n) => n.reason)).toBe(true);
    expect(p.known_limits).toHaveLength(2);
    expect(p.inventory_checked_on).toBe("2026-09-30");
    expect(JSON.stringify(p)).not.toMatch(/undefined/);
  });

  it("fails loudly if the count of 'Not built' bullets drops (parser or format change)", () => {
    const broken = real.replace(/^- Exams, marks and grading:.*$/m, "");
    expect(parseLlmsLimits(broken)!.not_built).toHaveLength(10);
  });
});
