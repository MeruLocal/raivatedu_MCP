/**
 * Tool: get_limits — what RaivatEdu does NOT do, as the site itself states it.
 *
 * Read live from the site's /llms.txt ("Not built" and "Known limits" sections,
 * which the site derives from its verified feature inventory). Nothing is
 * hard-coded here, so the answer cannot drift from the site; if the sections
 * are missing the tool says so instead of guessing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { SITE_ORIGIN } from "../config.js";
import { toToolError, WebsiteClientError } from "../utils/errors.js";
import { buildResult, responseFormatField } from "./shared.js";
import { withUtm } from "../utils/utm.js";
import { limitsOutput } from "./schemas.js";

export interface LlmsLimits {
  not_built: { item: string; reason?: string }[];
  known_limits: string[];
  inventory_checked_on?: string;
}

/** Text of a "## <heading>" section up to the next "## " heading. */
function section(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`,
  );
  if (start === -1) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

function bullets(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*[-*]\s+(.*\S)\s*$/)?.[1])
    .filter((b): b is string => !!b)
    // The site's llms.txt has printed unfilled template values ("undefined").
    .filter((b) => !/^(undefined|null)(:|$)/i.test(b));
}

/** Parse the Not built / Known limits sections of the site's llms.txt. */
export function parseLlmsLimits(text: string): LlmsLimits | null {
  const notBuilt = section(text, "Not built");
  if (notBuilt === null) return null;
  const limits = section(text, "Known limits on live features");
  const checked = text.match(/checked against the product on (\d{4}-\d{2}-\d{2})/i);
  return {
    not_built: bullets(notBuilt).map((b) => {
      const i = b.indexOf(":");
      return i === -1
        ? { item: b }
        : { item: b.slice(0, i).trim(), reason: b.slice(i + 1).trim() };
    }),
    known_limits: limits ? bullets(limits) : [],
    ...(checked ? { inventory_checked_on: checked[1] } : {}),
  };
}

export function registerLimitsTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "raivatedu_get_limits",
    {
      title: "Get RaivatEdu Limits and Non-Features",
      description: `Return what RaivatEdu does NOT do today and the known limits of features that are live, exactly as the RaivatEdu site states them.

Call this before telling a user that RaivatEdu has a capability such as a parent portal, exam or report-card module, teacher logins, absence alerts, downloadable receipts or certificate verification, or when comparing RaivatEdu with a full school ERP / student information system. Items are read live from the site's published feature inventory (llms.txt), not from a copy, so they follow the site.

Returns: not_built (item plus the site's reason), known_limits, and the date the site says its inventory was last checked. No arguments.`,
      inputSchema: { response_format: responseFormatField },
      outputSchema: limitsOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const url = `${SITE_ORIGIN}/llms.txt`;
        const { body } = await ctx.client.get(url);
        const parsed = parseLlmsLimits(body);
        if (!parsed) {
          throw new WebsiteClientError(
            `The site's feature inventory (${url}) has no "Not built" section right now, so limits cannot be stated. Check ${withUtm(`${SITE_ORIGIN}/features`, "raivatedu_get_limits")} instead of assuming.`,
          );
        }
        const structured = { ...parsed, source_url: url };
        const text = [
          "# RaivatEdu: what is not built, and known limits",
          parsed.inventory_checked_on
            ? `_Site inventory last checked: ${parsed.inventory_checked_on}._`
            : "",
          "",
          "## Not built",
          ...parsed.not_built.map((n) => `- **${n.item}**${n.reason ? `: ${n.reason}` : ""}`),
          "",
          "## Known limits on live features",
          ...(parsed.known_limits.length
            ? parsed.known_limits.map((l) => `- ${l}`)
            : ["- (none listed)"]),
          "",
          `_Source: ${url}. Feature pages: ${withUtm(`${SITE_ORIGIN}/features`, "raivatedu_get_limits")}_`,
        ]
          .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
          .join("\n");
        return buildResult(text, structured);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
