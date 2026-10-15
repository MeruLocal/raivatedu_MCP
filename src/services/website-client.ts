/**
 * Thin, SSRF-safe HTTP client for the RaivatEdu website.
 *
 * Responsibilities:
 *  - Enforce the origin/path allowlist (via utils/url) before every request.
 *  - Follow redirects manually, checking every hop (HTTPS, allowed host, never
 *    /api) BEFORE it is fetched.
 *  - Cap the size and content type of every response body.
 *  - Apply a per-request timeout using AbortController.
 *  - Retry transient failures (network errors, 5xx, 429) with backoff.
 *  - Cap simultaneous outbound requests and space them out to stay polite.
 *  - Cache successful GETs for a short TTL and share in-flight fetches.
 *
 * One client is shared by the whole process (see getSharedWebsiteClient), so
 * the throttle, concurrency cap and cache apply across every MCP request.
 */

import type { RuntimeConfig } from "../config.js";
import { WebsiteClientError } from "../utils/errors.js";
import { lookupPath } from "../utils/url.js";
import type { Logger } from "../utils/logger.js";
import { ALLOWED_HOSTS, DISALLOWED_PATH_PREFIXES } from "../config.js";

export interface FetchResult {
  status: number;
  url: string;
  body: string;
  contentType: string;
  elapsedMs: number;
}

export interface HeadResult {
  ok: boolean;
  status: number;
  url: string;
  elapsedMs: number;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Maximum redirect hops followed for one request. */
export const MAX_REDIRECTS = 5;
const ACCEPTED_CONTENT_TYPE = /^(text\/html|application\/xhtml\+xml|[a-z]+\/(?:[a-z0-9.+-]+\+)?xml)\s*(;|$)/i;

/** Minimal counting semaphore capping concurrent outbound requests. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // The releasing caller handed its slot straight to us.
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

interface CacheEntry {
  expires: number;
  value: FetchResult;
}

function isBlockedPath(pathname: string): boolean {
  return DISALLOWED_PATH_PREFIXES.some((bad) => {
    const prefix = bad.endsWith("/") ? bad.slice(0, -1) : bad;
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

export class WebsiteClient {
  private readonly config: RuntimeConfig;
  private readonly logger: Logger;
  /** Promise chain used to space out outbound requests. */
  private gate: Promise<void> = Promise.resolve();
  private readonly slots: Semaphore;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<FetchResult>>();

  constructor(config: RuntimeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.slots = new Semaphore(Math.max(1, config.maxConcurrentRequests ?? 4));
  }

  /** Enforce the minimum interval between outbound requests. */
  private async throttle(): Promise<void> {
    const interval = this.config.minRequestIntervalMs;
    if (interval <= 0) return;
    const prior = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    setTimeout(release, interval);
  }

  private assertAllowedHost(url: string): void {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new WebsiteClientError(`Malformed URL: ${url}`, { url });
    }
    if (!ALLOWED_HOSTS.has(host)) {
      throw new WebsiteClientError(
        `Blocked request to disallowed host "${host}".`,
        { url },
      );
    }
  }

  /** Validate a redirect target before it is fetched. */
  private checkRedirect(from: string, location: string | null): string {
    if (!location) {
      throw new WebsiteClientError("Redirect without a Location header.", {
        url: from,
      });
    }
    let next: URL;
    try {
      next = new URL(location, from);
    } catch {
      throw new WebsiteClientError("Redirect to a malformed URL.", { url: from });
    }
    if (next.protocol !== "https:") {
      throw new WebsiteClientError("Refused a redirect to a non-HTTPS URL.", {
        url: from,
      });
    }
    if (!ALLOWED_HOSTS.has(next.hostname.toLowerCase())) {
      throw new WebsiteClientError(
        `Refused a redirect to disallowed host "${next.hostname}".`,
        { url: from },
      );
    }
    if (isBlockedPath(next.pathname)) {
      throw new WebsiteClientError(
        "Refused a redirect to a path blocked by robots.txt (/api/).",
        { url: from },
      );
    }
    if (!lookupPath(next.pathname)) {
      throw new WebsiteClientError(
        "Refused a redirect to a page outside the catalog.",
        { url: from },
      );
    }
    return next.toString();
  }

  /**
   * Perform one logical request (following checked redirects) while holding a
   * concurrency slot, and hand the final response to `consume` before the
   * slot and the timeout are released.
   */
  private async request<T>(
    url: string,
    method: "GET" | "HEAD",
    consume: (res: Response, finalUrl: string) => Promise<T>,
  ): Promise<T> {
    this.assertAllowedHost(url);
    await this.slots.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let current = url;
      for (let hop = 0; ; hop++) {
        await this.throttle();
        this.logger.debug(`${method} ${current}`);
        const res = await fetch(current, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": this.config.userAgent,
            Accept:
              method === "HEAD"
                ? "*/*"
                : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en",
          },
        });
        if (!REDIRECT_STATUSES.has(res.status)) {
          return await consume(res, current);
        }
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) {
          throw new WebsiteClientError(
            `Too many redirects (more than ${MAX_REDIRECTS}).`,
            { url },
          );
        }
        current = this.checkRedirect(current, res.headers.get("location"));
      }
    } catch (err) {
      if (err instanceof WebsiteClientError) throw err;
      const aborted =
        controller.signal.aborted ||
        (err instanceof Error &&
          (err.name === "AbortError" || /abort/i.test(err.message)));
      throw new WebsiteClientError(
        aborted
          ? `Request timed out after ${this.config.timeoutMs}ms`
          : `Network error: ${err instanceof Error ? err.message : String(err)}`,
        { url, retryable: true, timedOut: aborted },
      );
    } finally {
      clearTimeout(timer);
      this.slots.release();
    }
  }

  private async withRetries<T>(
    url: string,
    attempt: (tryNo: number) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i <= this.config.maxRetries; i++) {
      try {
        return await attempt(i);
      } catch (err) {
        lastError = err;
        const retryable =
          err instanceof WebsiteClientError && err.retryable;
        if (!retryable || i === this.config.maxRetries) break;
        const backoff = Math.min(2000, 200 * 2 ** i);
        this.logger.warn(
          `Retrying ${url} (attempt ${i + 2}/${this.config.maxRetries + 1}) after ${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastError;
  }

  /** Read a body as text, refusing anything above maxResponseBytes. */
  private async readCapped(res: Response, url: string): Promise<string> {
    const max = this.config.maxResponseBytes ?? 2 * 1024 * 1024;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new WebsiteClientError(
        `Response too large (${declared} bytes; limit ${max}).`,
        { url, status: res.status },
      );
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > max) {
        await reader.cancel().catch(() => undefined);
        throw new WebsiteClientError(
          `Response too large (over ${max} bytes).`,
          { url, status: res.status },
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  private async fetchPage(url: string): Promise<FetchResult> {
    return this.withRetries(url, () => {
      const started = Date.now();
      return this.request(url, "GET", async (res, finalUrl) => {
        const elapsedMs = Date.now() - started;
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new WebsiteClientError(
            res.status === 404
              ? "Page not found."
              : `Request failed with status ${res.status}.`,
            {
              status: res.status,
              url,
              retryable: RETRYABLE_STATUSES.has(res.status),
            },
          );
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!ACCEPTED_CONTENT_TYPE.test(contentType.trim())) {
          await res.body?.cancel().catch(() => undefined);
          throw new WebsiteClientError(
            `Refused unexpected content type "${contentType || "(none)"}".`,
            { url, status: res.status },
          );
        }
        const body = await this.readCapped(res, url);
        return { status: res.status, url: finalUrl, body, contentType, elapsedMs };
      });
    });
  }

  /**
   * Fetch a page body as text. Non-2xx responses throw WebsiteClientError.
   * Successful results are cached for cacheTtlMs; concurrent calls for the
   * same URL share one fetch. Errors are never cached.
   */
  async get(url: string): Promise<FetchResult> {
    const ttl = this.config.cacheTtlMs ?? 0;
    if (ttl > 0) {
      const hit = this.cache.get(url);
      if (hit) {
        this.cache.delete(url);
        if (hit.expires > Date.now()) {
          this.cache.set(url, hit); // refresh LRU position
          return hit.value;
        }
      }
    }
    const pending = this.inFlight.get(url);
    if (pending) return pending;

    const promise = this.fetchPage(url)
      .then((value) => {
        if (ttl > 0) this.store(url, value, ttl);
        return value;
      })
      .finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, promise);
    return promise;
  }

  private store(url: string, value: FetchResult, ttl: number): void {
    const max = Math.max(1, this.config.cacheMaxEntries ?? 500);
    this.cache.delete(url);
    while (this.cache.size >= max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(url, { expires: Date.now() + ttl, value });
  }

  /** Lightweight reachability check. Never throws for non-2xx; reports status. Never cached. */
  async head(url: string): Promise<HeadResult> {
    return this.withRetries(url, () => {
      const started = Date.now();
      return this.request(url, "HEAD", async (res, finalUrl) => {
        await res.body?.cancel().catch(() => undefined);
        return {
          ok: res.ok,
          status: res.status,
          url: finalUrl,
          elapsedMs: Date.now() - started,
        };
      });
    });
  }
}

let shared: WebsiteClient | undefined;

/** Process-wide client, so throttle, concurrency cap and cache are global. */
export function getSharedWebsiteClient(
  config: RuntimeConfig,
  logger: Logger,
): WebsiteClient {
  if (!shared) shared = new WebsiteClient(config, logger);
  return shared;
}

/** Test hook: forget the shared client. */
export function resetSharedWebsiteClient(): void {
  shared = undefined;
}
