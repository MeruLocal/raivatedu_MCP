import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("official identity", () => {
  it("package.json points at the real repository", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.repository.url).toContain("MeruLocal/raivatedu_MCP");
    expect(pkg.bugs.url).toContain("MeruLocal/raivatedu_MCP/issues");
    expect(pkg.homepage).toBeTruthy();
  });

  it.each(["README.md", "LICENSE", ".env.example"])(
    "%s has no unofficial / not-affiliated / placeholder wording",
    (f) => {
      expect(read(f)).not.toMatch(/unofficial|not affiliated|your-org/i);
    },
  );

  it("README documents the HTTP transport", () => {
    const readme = read("README.md");
    expect(readme).toContain("/mcp");
    expect(readme).toContain("PORT");
  });

  it("keeps the marks owner sentence unchanged", () => {
    expect(read("LICENSE")).toContain(
      '"RaivatEdu" and related marks belong to RaivatEdu Technologies Pvt. Ltd.',
    );
  });
});
