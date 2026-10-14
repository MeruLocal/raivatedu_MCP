/** Helpers shared across tool modules: response formatting, common schemas. */

import { z } from "zod";
import { CHARACTER_LIMIT, MARKETS } from "../config.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/**
 * Deprecated `response_format` parameter, still accepted so existing callers
 * do not break. The text content is always markdown; the full object is in
 * `structuredContent` (described by each tool's outputSchema).
 */
export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Deprecated and ignored: the text is always markdown and the full object is always in structuredContent.",
  );

/** Reusable Zod field for an optional market/locale. */
export const marketField = z
  .enum(MARKETS)
  .optional()
  .describe(
    `Market/locale segment. One of: ${MARKETS.join(", ")}. Defaults to the server's configured market (initially 'in' for India).`,
  );

/** Standard MCP success result carrying both text and structured content. */
export interface ToolSuccess {
  // Index signature keeps this assignable to the SDK's CallToolResult type.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
}

/**
 * Build a tool result. `text` is the human/markdown rendering; `structured`
 * is the machine-readable object exposed via structuredContent (validated
 * against the tool's outputSchema). Applies the character limit to the text.
 * The object is not repeated as JSON text, so clients never receive it twice.
 */
export function buildResult(
  text: string,
  structured: Record<string, unknown>,
  _format?: ResponseFormat,
): ToolSuccess {
  const body = text;
  const limited =
    body.length > CHARACTER_LIMIT
      ? body.slice(0, CHARACTER_LIMIT) +
        `\n\n…[truncated at ${CHARACTER_LIMIT} characters]`
      : body;
  return {
    content: [{ type: "text", text: limited }],
    structuredContent: structured,
  };
}

/** Escape pipe characters so values are safe inside a Markdown table cell. */
export function mdCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  return String(value).replace(/\|/g, "\\|");
}
