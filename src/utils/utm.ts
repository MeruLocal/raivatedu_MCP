/**
 * UTM tagging for links to the RaivatEdu website, so traffic an AI agent
 * sends there can be attributed in analytics.
 *
 * Only own-site URLs (hosts in ALLOWED_HOSTS) are tagged; any other URL is
 * returned unchanged. Existing query parameters and #fragments are kept, and
 * a UTM key that is already set is never overwritten. Tagged URLs can still be
 * passed back to raivatedu_get_page_content, which ignores the query string.
 */

import { ALLOWED_HOSTS } from "../config.js";

export const UTM_SOURCE = "mcp";
export const UTM_MEDIUM = "ai_agent";

export function withUtm(url: string, campaign: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return url;
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return url;
  const params: [string, string][] = [
    ["utm_source", UTM_SOURCE],
    ["utm_medium", UTM_MEDIUM],
    ["utm_campaign", campaign],
  ];
  for (const [k, v] of params) {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  }
  return u.toString();
}
