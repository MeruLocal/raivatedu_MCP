import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Live smoke tests hit the real website. They are opt-in via RUN_SMOKE=1
    // so the default `npm test` run stays fully offline and deterministic.
    exclude: ["node_modules", "dist"],
    globals: false,
    testTimeout: 15000,
  },
});
