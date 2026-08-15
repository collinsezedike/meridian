import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**"],
      thresholds: {
        lines: 85,
        branches: 95,
        functions: 95,
        statements: 85,
      },
    },
  },
});
