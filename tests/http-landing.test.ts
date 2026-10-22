import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEFAULT_PUBLIC_BASE_URL,
  createHttpApp,
  discoveryDoc,
  publicBaseUrl,
  statusPage,
} from "../src/http.js";
import { loadHttpSecurityConfig } from "../src/http-security.js";
import { SERVER_VERSION, loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { resetSharedWebsiteClient } from "../src/services/website-client.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("publicBaseUrl", () => {
  it("defaults to the public host", () => {
    expect(publicBaseUrl({})).toBe("https://mcp.raivatedu.com");
  });
  it("accepts a custom http(s) URL and strips the trailing slash", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "http://localhost:3000/" })).toBe(
      "http://localhost:3000",
    );
  });
  it("falls back on an invalid value", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "javascript:alert(1)" })).toBe(DEFAULT_PUBLIC_BASE_URL);
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "not a url" })).toBe(DEFAULT_PUBLIC_BASE_URL);
  });
});

describe("discoveryDoc", () => {
  it("advertises the public /mcp URL, never localhost", () => {
    const doc = discoveryDoc("https://mcp.raivatedu.com");
    expect(doc.transport.endpoint).toBe("https://mcp.raivatedu.com/mcp");
  });
  it("does not hand-list tools", () => {
    expect("tools" in discoveryDoc(DEFAULT_PUBLIC_BASE_URL)).toBe(false);
  });
});

describe("statusPage", () => {
  const html = statusPage(DEFAULT_PUBLIC_BASE_URL);
  it("describes only what exists", () => {
    for (const word of ["newsletter", "contact-form", "comparisons", "/sse"]) {
      expect(html.toLowerCase()).not.toContain(word);
    }
    expect(html).toContain("https://mcp.raivatedu.com/mcp");
  });
  it("has no duplicated paragraphs or links", () => {
    expect(html.split("Read-only access to the public RaivatEdu website").length - 1).toBe(1);
    expect(html.split('href="/version"').length - 1).toBe(1);
    expect(html.split('href="/health"').length - 1).toBe(1);
  });
  it("escapes the base URL", () => {
    expect(statusPage('https://x.example/"><script>')).not.toContain("<script>");
  });
});

describe("HTTP landing routes", () => {
  let base: string;
  let server: Server;
  beforeAll(async () => {
    resetSharedWebsiteClient();
    const app = createHttpApp(
      loadConfig({ RAIVATEDU_LOG_LEVEL: "silent" }),
      { ...loadHttpSecurityConfig({}), rateLimitPerMin: 0 },
      "https://mcp.raivatedu.com",
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("serves the discovery doc with Access-Control-Allow-Origin: *", async () => {
    const r = await fetch(`${base}/.well-known/mcp.json`);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const doc = await r.json();
    expect(doc.transport.endpoint).toBe("https://mcp.raivatedu.com/mcp");
    expect(doc.tools).toBeUndefined();
  });

  it("/health is liveness only", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok" });
  });

  it("/version reports live counts and the MCP endpoint", async () => {
    const v = await (await fetch(`${base}/version`)).json();
    const { server: mcp } = createServer(loadConfig({ RAIVATEDU_LOG_LEVEL: "silent" }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(ct);
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    expect(v.tools).toBe(tools.length);
    expect(v.prompts).toBe(prompts.length);
    expect(v.version).toBe(pkg.version);
    expect(v.mcp_endpoint).toBe("https://mcp.raivatedu.com/mcp");
  });
});

describe("single-source version", () => {
  it("SERVER_VERSION comes from package.json", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });
  it("server.json parses, matches the version and points at /mcp", () => {
    const sj = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    expect(sj.version).toBe(pkg.version);
    expect(sj.remotes[0].url).toMatch(/\/mcp$/);
    expect(sj.packages).toBeUndefined();
  });
});

describe("server card and llms.txt", () => {
  let base: string;
  let server: Server;
  beforeAll(async () => {
    resetSharedWebsiteClient();
    const app = createHttpApp(
      loadConfig({ RAIVATEDU_LOG_LEVEL: "silent" }),
      { ...loadHttpSecurityConfig({}), rateLimitPerMin: 0 },
      "https://mcp.raivatedu.com",
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("serves a server card pointing at the public /mcp URL with no auth", async () => {
    const r = await fetch(`${base}/.well-known/mcp/server-card.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const card = await r.json();
    expect(card.serverInfo.version).toBe(pkg.version);
    expect(card.transport.endpoint).toBe("https://mcp.raivatedu.com/mcp");
    expect(card.authentication.required).toBe(false);
    expect(JSON.stringify(card)).not.toContain("localhost");
  });

  it("serves llms.txt as text/plain with every registered tool", async () => {
    const r = await fetch(`${base}/llms.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain/);
    const text = await r.text();
    const { server: mcp } = createServer(loadConfig({ RAIVATEDU_LOG_LEVEL: "silent" }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(ct);
    const { tools } = await client.listTools();
    for (const t of tools) expect(text).toContain(t.name);
    expect(text).toContain("https://mcp.raivatedu.com/mcp");
    expect(text).not.toMatch(/undefined|localhost/);
  });
});
