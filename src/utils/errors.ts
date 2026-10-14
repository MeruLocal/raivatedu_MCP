/**
 * Error types and helpers shared across the server.
 *
 * Tool handlers never throw to the transport; instead they catch and convert
 * errors into user-facing MCP error results via `toToolError`, so the agent
 * always gets an actionable message rather than a protocol-level failure.
 */

/** A request was rejected before/while contacting the website. */
export class WebsiteClientError extends Error {
  readonly status?: number;
  readonly url?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: { status?: number; url?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "WebsiteClientError";
    this.status = opts.status;
    this.url = opts.url;
    this.retryable = opts.retryable ?? false;
  }
}

/** Input failed a validation/safety check (bad market, blocked URL, etc.). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Shape of a tool error result (matches MCP `CallToolResult`). */
export interface ToolErrorResult {
  // Index signature keeps this assignable to the SDK's CallToolResult type.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError: true;
}

/** Build a standard MCP error result from any thrown value. */
export function toToolError(error: unknown): ToolErrorResult {
  let text: string;

  if (error instanceof ValidationError) {
    text = `Invalid request: ${error.message}`;
  } else if (error instanceof WebsiteClientError) {
    const parts = [`Error fetching from RaivatEdu: ${error.message}`];
    if (error.status) parts.push(`(HTTP ${error.status})`);
    if (error.url) parts.push(`URL: ${error.url}`);
    if (error.retryable) {
      parts.push("This looks transient — retrying in a moment may succeed.");
    }
    text = parts.join(" ");
  } else if (error instanceof Error) {
    text = `Unexpected error: ${error.message}`;
  } else {
    text = `Unexpected error: ${String(error)}`;
  }

  return { content: [{ type: "text", text }], isError: true };
}
