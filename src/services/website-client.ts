/**
 * Thin, SSRF-safe HTTP client for the RaivatEdu website.
 *
 * Responsibilities:
 *  - Enforce the origin/path allowlist (via utils/url) before every request.
 *  - Apply a per-request timeout using AbortController.
 *  - Retry transient failures (network errors, 5xx, 429) with backoff.
 *  - Serialize requests behind a minimum interval to stay polite.
 *  - Reuse a single User-Agent and keep-alive connections (native fetch).
 */

import type { RuntimeConfig } from "../config.js";
import { WebsiteClientError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { ALLOWED_HOSTS } from "../config.js";

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

export class WebsiteClient {
  private readonly config: RuntimeConfig;
  private readonly logger: Logger;
  /** Promise chain used to serialize + space out outbound requests. */
  private gate: Promise<void> = Promise.resolve();

  constructor(config: RuntimeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
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

  private async doRequest(
    url: string,
    method: "GET" | "HEAD",
  ): Promise<Response> {
    this.assertAllowedHost(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      await this.throttle();
      this.logger.debug(`${method} ${url}`);
      const res = await fetch(url, {
        method,
        redirect: "follow",
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
      // Guard against redirects that escaped to a disallowed host.
      this.assertAllowedHost(res.url || url);
      return res;
    } catch (err) {
      if (err instanceof WebsiteClientError) throw err;
      const aborted =
        err instanceof Error &&
        (err.name === "AbortError" || /abort/i.test(err.message));
      throw new WebsiteClientError(
        aborted
          ? `Request timed out after ${this.config.timeoutMs}ms`
          : `Network error: ${err instanceof Error ? err.message : String(err)}`,
        { url, retryable: true },
      );
    } finally {
      clearTimeout(timer);
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

  /** Fetch a page body as text. Non-2xx responses throw WebsiteClientError. */
  async get(url: string): Promise<FetchResult> {
    return this.withRetries(url, async () => {
      const started = Date.now();
      const res = await this.doRequest(url, "GET");
      const elapsedMs = Date.now() - started;

      if (!res.ok) {
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

      const body = await res.text();
      return {
        status: res.status,
        url: res.url || url,
        body,
        contentType: res.headers.get("content-type") ?? "",
        elapsedMs,
      };
    });
  }

  /** Lightweight reachability check. Never throws for non-2xx; reports status. */
  async head(url: string): Promise<HeadResult> {
    return this.withRetries(url, async () => {
      const started = Date.now();
      const res = await this.doRequest(url, "HEAD");
      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        elapsedMs: Date.now() - started,
      };
    });
  }
}
