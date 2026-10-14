import { describe, it, expect } from "vitest";
import {
  CATALOG,
  normalizePath,
  lookupPath,
  resolveToSafeUrl,
  isValidMarket,
} from "../src/utils/url.js";
import { ValidationError } from "../src/utils/errors.js";

describe("page catalog", () => {
  it("contains the expected number of pages", () => {
    // 10 markets * (17 market pages + 9 features + 4 solutions + 6 resources)
    // = 10 * 36 = 360, plus 1 global careers page = 361.
    expect(CATALOG.length).toBe(361);
  });

  it("includes market home, feature, solution and resource pages", () => {
    const paths = new Set(CATALOG.map((p) => p.path));
    expect(paths.has("/in")).toBe(true);
    expect(paths.has("/in/pricing")).toBe(true);
    expect(paths.has("/in/features/admissions")).toBe(true);
    expect(paths.has("/us/solutions/schools")).toBe(true);
    expect(paths.has("/gb/resources/migrating-from-spreadsheets")).toBe(true);
    expect(paths.has("/careers")).toBe(true);
  });
});

describe("normalizePath", () => {
  it("adds a leading slash and strips trailing slash, query and hash", () => {
    expect(normalizePath("in/pricing")).toBe("/in/pricing");
    expect(normalizePath("/in/pricing/")).toBe("/in/pricing");
    expect(normalizePath("/in/pricing?utm=x#top")).toBe("/in/pricing");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("lookupPath / isValidMarket", () => {
  it("resolves known paths and rejects unknown ones", () => {
    expect(lookupPath("/in/pricing")?.type).toBe("pricing");
    expect(lookupPath("/in/nonsense")).toBeUndefined();
  });
  it("validates markets", () => {
    expect(isValidMarket("in")).toBe(true);
    expect(isValidMarket("xx")).toBe(false);
  });
});

describe("resolveToSafeUrl (SSRF guard)", () => {
  it("accepts a known path", () => {
    const page = resolveToSafeUrl("/in/features/admissions");
    expect(page.url).toBe("https://www.raivatedu.com/in/features/admissions");
    expect(page.type).toBe("feature");
  });

  it("accepts a full canonical URL and a www-less URL", () => {
    expect(resolveToSafeUrl("https://www.raivatedu.com/in/pricing").type).toBe("pricing");
    expect(resolveToSafeUrl("https://raivatedu.com/in/pricing").type).toBe("pricing");
  });

  it("rejects a disallowed host", () => {
    expect(() => resolveToSafeUrl("https://evil.example.com/in")).toThrow(ValidationError);
  });

  it("rejects /api/ paths (robots.txt)", () => {
    expect(() => resolveToSafeUrl("/api/secret")).toThrow(/robots\.txt/);
  });

  it("rejects unknown paths with a helpful message", () => {
    expect(() => resolveToSafeUrl("/in/../etc/passwd")).toThrow(/not a known public/);
  });

  it("rejects an empty reference", () => {
    expect(() => resolveToSafeUrl("   ")).toThrow(ValidationError);
  });

  it("rejects non-http protocols", () => {
    expect(() => resolveToSafeUrl("file:///etc/passwd")).toThrow();
  });
});
