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
    // 10 markets * (22 market pages + 9 features + 4 solutions + 6 resources)
    // = 10 * 41 = 410, plus 1 global careers page = 411.
    expect(CATALOG.length).toBe(411);
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

describe("allowlist stays closed around the landing and glossary pages", () => {
  it("accepts only the exact landing and glossary index paths", () => {
    for (const p of [
      "/in/school-management-software",
      "/us/admission-management-software",
      "/gb/student-management-system",
      "/au/attendance-management-system",
      "/sg/glossary",
    ]) {
      expect(lookupPath(p), p).toBeDefined();
    }
  });

  it("ignores a port or query in a full URL and returns the canonical URL", () => {
    expect(resolveToSafeUrl("https://www.raivatedu.com:8443/in/school-management-software?x=1").url).toBe(
      "https://www.raivatedu.com/in/school-management-software",
    );
  });

  it("rejects look-alikes, traversal, encoded separators and other hosts", () => {
    for (const bad of [
      "/in/school-management-software/extra",
      "/in/school-management-softwares",
      "/xx/school-management-software",
      "/school-management-software",
      "/in/glossary/../api/x",
      "/in/school-management-software/../../api/leads",
      "/in/glossary/%2e%2e/api",
      "/in/glossary%2Fcbse",
      "//evil.example/in/glossary",
      "https://evil.example/in/school-management-software",
      "https://www.raivatedu.com.evil.example/in/school-management-software",
      "/api/in/school-management-software",
    ]) {
      expect(() => resolveToSafeUrl(bad), bad).toThrow(ValidationError);
    }
  });
});
