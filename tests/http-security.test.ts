import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import {
  clientKey,
  jsonErrorHandler,
  parseTrustProxy,
  loadHttpSecurityConfig,
  mcpGuards,
  rateLimit,
  type HttpSecurityConfig,
} from "../src/http-security.js";
import { createHttpApp } from "../src/http.js";
import { loadConfig, SITE_ORIGIN } from "../src/config.js";
import { WebsiteClient, MAX_REDIRECTS } from "../src/services/website-client.js";
import { resetSharedWebsiteClient } from "../src/services/website-client.js";
import { createLogger } from "../src/utils/logger.js";
import { WebsiteClientError } from "../src/utils/errors.js";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};

async function listen(app: express.Express): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, server });
    });
  });
}

function guardedApp(cfg: Partial<HttpSecurityConfig> = {}) {
  const sec = { ...loadHttpSecurityConfig({}), ...cfg };
  const app = express();
  app.use("/mcp", ...mcpGuards(sec));
  app.use(express.json({ limit: "1mb" }));
  app.post("/mcp", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/boom", () => {
    throw new Error("secret internal detail at /srv/app/node_modules/x.js");
  });
  app.use(jsonErrorHandler());
  return app;
}

async function post(base: string, path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body,
  });
}

/** POST with an explicit Host header (fetch does not let us override Host). */
function postWithHost(base: string, path: string, body: string, host: string): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path,
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("loadHttpSecurityConfig", () => {
  it("has safe defaults", () => {
    const c = loadHttpSecurityConfig({});
    expect(c.allowedHosts).toContain("mcp.raivatedu.com");
    expect(c.allowedOrigins).toContain("https://www.raivatedu.com");
    expect(c.rateLimitPerMin).toBe(60);
    expect(c.trustProxy).toBe(0);
  });
  it("reads overrides; 0 turns the limit off", () => {
    const c = loadHttpSecurityConfig({
      MCP_ALLOWED_HOSTS: "a.example, B.example",
      MCP_RATE_LIMIT_PER_MIN: "0",
      TRUST_PROXY: "1",
    });
    expect(c.allowedHosts).toEqual(["a.example", "b.example"]);
    expect(c.rateLimitPerMin).toBe(0);
    expect(c.trustProxy).toBe(1);
  });
});

describe("clientKey hop count", () => {
  const mk = (xff: string | undefined) =>
    ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "10.0.0.1" } }) as never;
  const h = "9.9.9.9, 1.1.1.1, 2.2.2.2";
  it("0 hops uses the socket address", () => expect(clientKey(mk(h), 0)).toBe("10.0.0.1"));
  it("1 hop uses the right-most entry", () => expect(clientKey(mk(h), 1)).toBe("2.2.2.2"));
  it("2 hops uses the second from the right", () => expect(clientKey(mk(h), 2)).toBe("1.1.1.1"));
  it("a short header falls back to the socket", () => expect(clientKey(mk("2.2.2.2"), 2)).toBe("10.0.0.1"));
  it("parses TRUST_PROXY", () => {
    expect([parseTrustProxy("true"), parseTrustProxy("2"), parseTrustProxy("0"), parseTrustProxy("junk"), parseTrustProxy(undefined)]).toEqual([1, 2, 0, 0, 0]);
  });
});

describe("origin, host and body guards", () => {
  let base: string;
  let server: Server;
  beforeAll(async () => {
    ({ base, server } = await listen(guardedApp({ rateLimitPerMin: 0 })));
  });
  afterAll(() => server.close());

  it("refuses a foreign Origin with 403", async () => {
    const r = await post(base, "/mcp", "{}", { origin: "http://evil.example" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe(-32000);
  });

  it("accepts no Origin, an allowed origin and a localhost origin", async () => {
    expect((await post(base, "/mcp", "{}")).status).toBe(200);
    expect(
      (await post(base, "/mcp", "{}", { origin: "https://www.raivatedu.com" })).status,
    ).toBe(200);
    expect(
      (await post(base, "/mcp", "{}", { origin: "http://localhost:6274" })).status,
    ).toBe(200);
  });

  it("refuses a Host that is not on the list", async () => {
    expect(await postWithHost(base, "/mcp", "{}", "evil.example")).toBe(403);
    expect(await postWithHost(base, "/mcp", "{}", "localhost:3000")).toBe(200);
  });

  it("answers a 1.1 MB body with a JSON 413 and no stack trace", async () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const big = JSON.stringify({ x: "a".repeat(1.1 * 1024 * 1024) });
      const r = await post(base, "/mcp", big);
      expect(r.status).toBe(413);
      expect(r.headers.get("content-type")).toMatch(/json/);
      const text = await r.text();
      expect(text).not.toMatch(/\bat |node_modules|\/(?:home|srv|tmp|app)\//);
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
    }
  });

  it("answers malformed JSON with a JSON-RPC parse error and no stack trace", async () => {
    const r = await post(base, "/mcp", "{bad");
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(JSON.parse(text).error.code).toBe(-32700);
    expect(text).not.toMatch(/\bat |node_modules|SyntaxError/);
  });

  it("turns a thrown error into a generic 500 without the internal message", async () => {
    const r = await post(base, "/boom", "{}");
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).toContain("Internal server error");
    expect(text).not.toContain("secret internal detail");
    expect(text).not.toContain("node_modules");
  });
});

describe("rate limit", () => {
  it("returns 429 with Retry-After after the limit", async () => {
    const { base, server } = await listen(guardedApp({ rateLimitPerMin: 3 }));
    try {
      for (let i = 0; i < 3; i++) expect((await post(base, "/mcp", "{}")).status).toBe(200);
      const r = await post(base, "/mcp", "{}");
      expect(r.status).toBe(429);
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("with TRUST_PROXY a spoofed left-most XFF hop does not get a fresh bucket", async () => {
    const { base, server } = await listen(
      guardedApp({ rateLimitPerMin: 2, trustProxy: 1 }),
    );
    try {
      const h = (spoof: string) => ({ "x-forwarded-for": `${spoof}, 203.0.113.7` });
      expect((await post(base, "/mcp", "{}", h("1.1.1.1"))).status).toBe(200);
      expect((await post(base, "/mcp", "{}", h("2.2.2.2"))).status).toBe(200);
      expect((await post(base, "/mcp", "{}", h("3.3.3.3"))).status).toBe(429);
    } finally {
      server.close();
    }
  });

  it("opens a new window after a minute", () => {
    let t = 0;
    const mw = rateLimit(1, false, () => t);
    const req = { headers: {}, socket: { remoteAddress: "x" } } as never;
    const statuses: number[] = [];
    const res = {
      status(s: number) {
        statuses.push(s);
        return this;
      },
      json() {
        return this;
      },
      setHeader() {},
    } as never;
    const next = vi.fn();
    mw(req, res, next);
    mw(req, res, next);
    t = 60001;
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([429]);
  });
});

describe("the real HTTP app", () => {
  let base: string;
  let server: Server;
  beforeAll(async () => {
    resetSharedWebsiteClient();
    const app = createHttpApp(
      loadConfig({ RAIVATEDU_LOG_LEVEL: "silent" }),
      { ...loadHttpSecurityConfig({}), rateLimitPerMin: 0 },
    );
    ({ base, server } = await listen(app));
  });
  afterAll(() => server.close());

  it("refuses a foreign Origin on /mcp", async () => {
    const r = await post(base, "/mcp", JSON.stringify(INIT), { origin: "http://evil.example" });
    expect(r.status).toBe(403);
  });

  it("refuses a foreign Host on /mcp", async () => {
    expect(await postWithHost(base, "/mcp", JSON.stringify(INIT), "evil.example")).toBe(403);
  });

  it("still answers initialize without an Origin", async () => {
    const r = await post(base, "/mcp", JSON.stringify(INIT));
    expect(r.status).toBe(200);
  });

  it("keeps /health open and hides x-powered-by", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-powered-by")).toBeNull();
  });

  it("returns JSON (not an HTML stack page) for malformed JSON", async () => {
    const r = await post(base, "/mcp", "{bad");
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toMatch(/json/);
    expect(await r.text()).not.toMatch(/node_modules|<pre>/);
  });
});

describe("outbound response cap", () => {
  const logger = createLogger({ logLevel: "silent" });
  const client = () =>
    new WebsiteClient(
      { ...loadConfig({}), minRequestIntervalMs: 0, maxRetries: 0, timeoutMs: 2000 },
      logger,
    );
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a declared 3 MB response before reading it", async () => {
    let pulled = 0;
    const body = new ReadableStream({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(body, {
          headers: { "content-type": "text/html", "content-length": String(3 * 1024 * 1024) },
        }),
      ),
    );
    await expect(client().get(`${SITE_ORIGIN}/in`)).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThan(5);
  });

  it("aborts a stream with no Content-Length once it passes 2 MB", async () => {
    let sent = 0;
    const body = new ReadableStream({
      pull(c) {
        sent += 64 * 1024;
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "content-type": "text/html" } })),
    );
    await expect(client().get(`${SITE_ORIGIN}/in`)).rejects.toThrow(/too large/);
    expect(sent).toBeLessThan(2 * 1024 * 1024 + 256 * 1024);
  });

  it("refuses an image/png response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("png", { headers: { "content-type": "image/png" } })),
    );
    await expect(client().get(`${SITE_ORIGIN}/in`)).rejects.toThrow(/content type/);
  });

  it("accepts XML (for sitemaps)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<urlset/>", { headers: { "content-type": "application/xml" } })),
    );
    await expect(client().get(`${SITE_ORIGIN}/in`)).resolves.toMatchObject({ body: "<urlset/>" });
  });
});

describe("checked redirects", () => {
  const logger = createLogger({ logLevel: "silent" });
  const client = () =>
    new WebsiteClient(
      { ...loadConfig({}), minRequestIntervalMs: 0, maxRetries: 0, timeoutMs: 2000 },
      logger,
    );
  const redirect = (location: string) =>
    new Response(null, { status: 302, headers: { location } });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an off-domain target without fetching it", async () => {
    const f = vi.fn(async () => redirect("https://evil.example/x"));
    vi.stubGlobal("fetch", f);
    await expect(client().get(`${SITE_ORIGIN}/in`)).rejects.toBeInstanceOf(WebsiteClientError);
    expect(f).toHaveBeenCalledTimes(1);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("manual");
  });

  it("refuses http:// and /api/ targets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => redirect("http://www.raivatedu.com/in")));
    await expect(client().get(`${SITE_ORIGIN}/in`)).rejects.toThrow(/non-HTTPS/);
    vi.stubGlobal("fetch", vi.fn(async () => redirect("/api/secret")));
    await expect(client().get(`${SITE_ORIGIN}/in`)).rejects.toThrow(/robots/);
  });

  it("follows an on-domain redirect", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://raivatedu.com/in/"))
      .mockResolvedValueOnce(
        new Response("<h1>ok</h1>", { headers: { "content-type": "text/html" } }),
      );
    vi.stubGlobal("fetch", f);
    const res = await client().get(`${SITE_ORIGIN}/in`);
    expect(res.body).toContain("ok");
    expect(res.url).toBe("https://raivatedu.com/in/");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("stops after the hop limit", async () => {
    const f = vi.fn(async () => redirect(`${SITE_ORIGIN}/in`));
    vi.stubGlobal("fetch", f);
    await expect(client().get(`${SITE_ORIGIN}/in`)).rejects.toThrow(/Too many redirects/);
    expect(f).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});
