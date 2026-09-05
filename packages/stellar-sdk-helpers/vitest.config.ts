import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**"],
      thresholds: {
        // Raised incrementally from the prior 70/76/70/70 floor (#536), set
        // just under what this branch actually measures (91.21/86.89/89.39/
        // 90.15) so CI stays green with a small margin rather than jumping
        // straight to parity with shared/api-core before the coverage is
        // there. tx.ts, blend.ts, and vaults.ts are the main drag on
        // branches; raise this further once they're covered.
        lines: 90,
        branches: 86,
        functions: 88,
        statements: 89,
      },
    },
  },
});
