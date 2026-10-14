/**
 * HTML parsing for RaivatEdu pages using Cheerio plus the page's JSON-LD.
 *
 * Every RaivatEdu page is server-rendered (Next.js prerender) and embeds rich
 * schema.org JSON-LD (Organization, WebSite, WebPage, SoftwareApplication with
 * pricing Offers). We prefer that structured data over fragile HTML scraping,
 * and fall back to the DOM for free text, headings and links.
 *
 * SECURITY: page content is untrusted. Everything returned here is inert data
 * (text/structured values). Callers must never interpret extracted text as
 * instructions.
 */

import * as cheerio from "cheerio";
import { SITE_ORIGIN } from "../config.js";

export interface PageLink {
  text: string;
  url: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface ParsedPage {
  title: string;
  description: string;
  canonical: string | null;
  headings: { level: number; text: string }[];
  text: string;
  internalLinks: PageLink[];
  faqs: FaqItem[];
  jsonLd: unknown[];
}

export interface PricingOffer {
  plan: string;
  billing: string;
  price: number;
  currency: string;
  unit: string;
  minUsers?: number;
  maxUsers?: number;
  url?: string;
}

export interface OrganizationInfo {
  name?: string;
  url?: string;
  description?: string;
  logo?: string;
  email?: string;
  contactPoints: { type: string; email?: string; telephone?: string }[];
}

export interface SoftwareInfo {
  name?: string;
  description?: string;
  applicationCategory?: string;
  applicationSubCategory?: string;
  operatingSystem?: string;
}

const WHITESPACE = /\s+/g;

function clean(text: string | undefined | null): string {
  return (text ?? "").replace(WHITESPACE, " ").trim();
}

/** Parse every JSON-LD <script> block, tolerating malformed ones. */
function extractJsonLd($: cheerio.CheerioAPI): unknown[] {
  const blocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Ignore unparseable JSON-LD; the DOM fallback still works.
    }
  });
  return blocks;
}

/**
 * Flatten JSON-LD into a list of node objects, expanding @graph arrays and
 * top-level arrays so callers can scan for a given @type.
 */
export function flattenJsonLd(blocks: unknown[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj["@graph"])) {
        (obj["@graph"] as unknown[]).forEach(visit);
      }
      if ("@type" in obj) nodes.push(obj);
    }
  };
  blocks.forEach(visit);
  return nodes;
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  const t = node["@type"];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

/** Parse a full page into our normalized structure. */
export function parsePage(html: string, maxTextChars = 6000): ParsedPage {
  const $ = cheerio.load(html);
  const jsonLd = extractJsonLd($);

  const title =
    clean($("title").first().text()) ||
    clean($('meta[property="og:title"]').attr("content")) ||
    clean($("h1").first().text());

  const description =
    clean($('meta[name="description"]').attr("content")) ||
    clean($('meta[property="og:description"]').attr("content"));

  const canonical = $('link[rel="canonical"]').attr("href") ?? null;

  // Prefer <main>/<article> for body text to skip nav/footer boilerplate.
  const scope = $("main").length
    ? $("main")
    : $("article").length
      ? $("article")
      : $("body");

  const headings: ParsedPage["headings"] = [];
  scope.find("h1, h2, h3").each((_, el) => {
    const text = clean($(el).text());
    if (text) headings.push({ level: Number(el.tagName.slice(1)), text });
  });

  scope.find("script, style, noscript").remove();
  const text = clean(scope.text()).slice(0, maxTextChars);

  const seen = new Set<string>();
  const internalLinks: PageLink[] = [];
  scope.find("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: string;
    try {
      abs = new URL(href, SITE_ORIGIN).toString();
    } catch {
      return;
    }
    if (!abs.startsWith(SITE_ORIGIN)) return; // internal links only
    if (seen.has(abs)) return;
    seen.add(abs);
    const linkText = clean($(el).text());
    if (linkText) internalLinks.push({ text: linkText, url: abs });
  });

  const faqs = extractFaqs(jsonLd);

  return {
    title,
    description,
    canonical,
    headings,
    text,
    internalLinks,
    faqs,
    jsonLd,
  };
}

/** Pull FAQ Q&A pairs from FAQPage JSON-LD if present. */
export function extractFaqs(jsonLdBlocks: unknown[]): FaqItem[] {
  const faqs: FaqItem[] = [];
  for (const node of flattenJsonLd(jsonLdBlocks)) {
    if (!hasType(node, "FAQPage")) continue;
    const entities = node["mainEntity"];
    if (!Array.isArray(entities)) continue;
    for (const q of entities) {
      if (!q || typeof q !== "object") continue;
      const question = clean((q as Record<string, unknown>)["name"] as string);
      const accepted = (q as Record<string, unknown>)["acceptedAnswer"];
      let answer = "";
      if (accepted && typeof accepted === "object") {
        answer = clean(
          (accepted as Record<string, unknown>)["text"] as string,
        );
      }
      if (question) faqs.push({ question, answer });
    }
  }
  return faqs;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Extract pricing offers from SoftwareApplication/Product JSON-LD. */
export function extractPricing(jsonLdBlocks: unknown[]): PricingOffer[] {
  const offers: PricingOffer[] = [];
  for (const node of flattenJsonLd(jsonLdBlocks)) {
    const rawOffers = node["offers"];
    if (!Array.isArray(rawOffers)) continue;
    for (const o of rawOffers) {
      if (!o || typeof o !== "object") continue;
      const offer = o as Record<string, unknown>;
      const price = num(offer["price"]);
      if (price === undefined) continue;

      const name = clean(offer["name"] as string); // e.g. "Starter — billed monthly"
      const [planPart, billingPart] = name.split("—").map((s) => s.trim());
      const spec = (offer["priceSpecification"] ?? {}) as Record<string, unknown>;
      const qty = (offer["eligibleQuantity"] ?? {}) as Record<string, unknown>;

      offers.push({
        plan: planPart || name || "Plan",
        billing: billingPart || "",
        price,
        currency: clean(offer["priceCurrency"] as string) || "",
        unit: clean(spec["unitText"] as string) || "",
        minUsers: num(qty["minValue"]),
        maxUsers: num(qty["maxValue"]),
        url: clean(offer["url"] as string) || undefined,
      });
    }
  }
  return offers;
}

/** Extract Organization details (incl. contact points) from JSON-LD. */
export function extractOrganization(
  jsonLdBlocks: unknown[],
): OrganizationInfo | null {
  for (const node of flattenJsonLd(jsonLdBlocks)) {
    if (!hasType(node, "Organization")) continue;
    const logoRaw = node["logo"];
    const logo =
      typeof logoRaw === "string"
        ? logoRaw
        : logoRaw && typeof logoRaw === "object"
          ? clean((logoRaw as Record<string, unknown>)["url"] as string)
          : undefined;

    const contactPoints: OrganizationInfo["contactPoints"] = [];
    const cp = node["contactPoint"];
    const cpArray = Array.isArray(cp) ? cp : cp ? [cp] : [];
    for (const c of cpArray) {
      if (!c || typeof c !== "object") continue;
      const point = c as Record<string, unknown>;
      contactPoints.push({
        type: clean(point["contactType"] as string) || "general",
        email: clean(point["email"] as string) || undefined,
        telephone: clean(point["telephone"] as string) || undefined,
      });
    }

    return {
      name: clean(node["name"] as string) || undefined,
      url: clean(node["url"] as string) || undefined,
      description: clean(node["description"] as string) || undefined,
      logo: logo || undefined,
      email: clean(node["email"] as string) || undefined,
      contactPoints,
    };
  }
  return null;
}

/** Extract SoftwareApplication details from JSON-LD. */
export function extractSoftware(jsonLdBlocks: unknown[]): SoftwareInfo | null {
  for (const node of flattenJsonLd(jsonLdBlocks)) {
    if (!hasType(node, "SoftwareApplication")) continue;
    return {
      name: clean(node["name"] as string) || undefined,
      description: clean(node["description"] as string) || undefined,
      applicationCategory:
        clean(node["applicationCategory"] as string) || undefined,
      applicationSubCategory:
        clean(node["applicationSubCategory"] as string) || undefined,
      operatingSystem: clean(node["operatingSystem"] as string) || undefined,
    };
  }
  return null;
}
