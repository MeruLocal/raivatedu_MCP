import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebsiteClient } from "../src/services/website-client.js";
import { WebsiteClientError } from "../src/utils/errors.js";
import { createLogger } from "../src/utils/logger.js";
import { loadConfig, SITE_ORIGIN } from "../src/config.js";

const logger = createLogger({ logLevel: "silent" });

function makeClient(overrides = {}) {
  const config = {
    ...loadConfig({}),
    minRequestIntervalMs: 0, // no artificial delay in tests
    maxRetries: 2,
    timeoutMs: 1000,
    ...overrides,
  };
  return new WebsiteClient(config, logger);
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

describe("WebsiteClient", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("fetches a page body on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse("<h1>ok</h1>"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await makeClient().get(`${SITE_ORIGIN}/in`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["User-Agent"]).toContain("raivat-education-mcp-server");
  });

  it("blocks requests to a disallowed host without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(makeClient().get("https://evil.example.com/x")).rejects.toThrow(
      WebsiteClientError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a non-retryable error on 404 (single attempt)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse("nope", 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(makeClient().get(`${SITE_ORIGIN}/in`)).rejects.toMatchObject({
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries retryable 5xx responses up to maxRetries then fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse("boom", 503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      makeClient({ maxRetries: 2 }).get(`${SITE_ORIGIN}/in`),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("retries on a network error and can eventually succeed", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(htmlResponse("<h1>recovered</h1>"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await makeClient().get(`${SITE_ORIGIN}/in`);
    expect(res.body).toContain("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout as a retryable error", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      makeClient({ maxRetries: 0 }).get(`${SITE_ORIGIN}/in`),
    ).rejects.toThrow(/timed out/);
  });

  it("head() reports non-2xx status without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    // head() never throws on non-2xx — it just reports the status.
    const res = await makeClient({ maxRetries: 0 }).head(`${SITE_ORIGIN}/in`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it("follows a redirect to a catalog page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/in/pricing" } }))
      .mockResolvedValueOnce(htmlResponse("<h1>pricing</h1>"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await makeClient().get(`${SITE_ORIGIN}/in`);
    expect(res.body).toContain("pricing");
  });

  it("refuses a redirect to a path outside the catalog", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "/in/not-a-real-page" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(makeClient({ maxRetries: 0 }).get(`${SITE_ORIGIN}/in`)).rejects.toThrow(/outside the catalog/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
