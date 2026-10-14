import { describe, it, expect } from "vitest";
import {
  parsePage,
  extractPricing,
  extractOrganization,
  extractSoftware,
  extractFaqs,
  flattenJsonLd,
} from "../src/services/content-parser.js";
import { HOME_HTML, FAQ_HTML, BARE_HTML } from "./fixtures.js";

describe("parsePage", () => {
  const parsed = parsePage(HOME_HTML);

  it("extracts title, description and canonical", () => {
    expect(parsed.title).toBe("Education Software in India | RaivatEdu");
    expect(parsed.description).toContain("Education software for Indian");
    expect(parsed.canonical).toBe("https://www.raivatedu.com/in");
  });

  it("extracts headings from main", () => {
    expect(parsed.headings[0]).toEqual({
      level: 1,
      text: "Turn every enquiry into an enrolled student",
    });
  });

  it("strips script/style from body text", () => {
    expect(parsed.text).toContain("Manage enquiries");
    expect(parsed.text).not.toContain("should be stripped");
  });

  it("returns only internal links (absolute, deduped)", () => {
    const urls = parsed.internalLinks.map((l) => l.url);
    expect(urls).toContain("https://www.raivatedu.com/in/features/admissions");
    expect(urls.some((u) => u.includes("external.example.com"))).toBe(false);
  });

  it("tolerates malformed JSON-LD blocks", () => {
    // One of the two JSON-LD blocks in HOME_HTML is intentionally invalid.
    expect(parsed.jsonLd.length).toBe(1);
  });

  it("respects the max text length", () => {
    expect(parsePage(HOME_HTML, 20).text.length).toBeLessThanOrEqual(20);
  });

  it("falls back to body when there is no main/article", () => {
    const bare = parsePage(BARE_HTML);
    expect(bare.text).toContain("fallback text");
  });
});

describe("extractPricing", () => {
  it("parses offers into structured plans", () => {
    const plans = extractPricing(parsePage(HOME_HTML).jsonLd);
    expect(plans).toHaveLength(3);
    const starter = plans[0]!;
    expect(starter.plan).toBe("Starter");
    expect(starter.billing).toBe("billed monthly");
    expect(starter.price).toBe(3500);
    expect(starter.currency).toBe("INR");
    expect(starter.unit).toBe("per user per month");
    expect(starter.minUsers).toBe(3);
    expect(starter.maxUsers).toBe(10);
    // Enterprise is open-ended (no maxUsers).
    expect(plans[2]!.maxUsers).toBeUndefined();
    expect(plans[2]!.minUsers).toBe(5);
  });
});

describe("extractOrganization", () => {
  it("parses org name, email and contact points", () => {
    const org = extractOrganization(parsePage(HOME_HTML).jsonLd);
    expect(org?.name).toBe("RaivatEdu");
    expect(org?.email).toBe("hello@raivatedu.com");
    expect(org?.logo).toBe("https://www.raivatedu.com/brand/logo.png");
    expect(org?.contactPoints).toEqual([
      { type: "sales", email: "sales@raivatedu.com", telephone: undefined },
      { type: "customer support", email: "support@raivatedu.com", telephone: undefined },
    ]);
  });
});

describe("extractSoftware", () => {
  it("parses software application info", () => {
    const sw = extractSoftware(parsePage(HOME_HTML).jsonLd);
    expect(sw?.name).toBe("RaivatEdu");
    expect(sw?.applicationCategory).toBe("BusinessApplication");
    expect(sw?.operatingSystem).toBe("Web, iOS, Android");
  });
});

describe("extractFaqs", () => {
  it("parses FAQPage questions and answers", () => {
    const faqs = extractFaqs(parsePage(FAQ_HTML).jsonLd);
    expect(faqs).toHaveLength(2);
    expect(faqs[0]).toEqual({
      question: "Is there a free trial?",
      answer: "Yes, 14 days with no credit card.",
    });
  });

  it("returns an empty array when there is no FAQ", () => {
    expect(extractFaqs(parsePage(HOME_HTML).jsonLd)).toEqual([]);
  });
});

describe("flattenJsonLd", () => {
  it("expands @graph and arrays", () => {
    const nodes = flattenJsonLd([{ "@graph": [{ "@type": "A" }, { "@type": "B" }] }]);
    expect(nodes.map((n) => n["@type"])).toEqual(["A", "B"]);
  });
});
