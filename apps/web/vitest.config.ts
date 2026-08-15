import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // e2e/ holds Playwright specs (run via `pnpm test:e2e`), a separate test
    // runner with its own test.describe API; Vitest's default include glob
    // would otherwise pick them up and fail to execute them. Vitest replaces
    // (doesn't merge) the default exclude list when this is set, so its
    // usual defaults are repeated here alongside the e2e addition.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
      "e2e/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**"],
      thresholds: {
        lines: 70,
        branches: 45,
        functions: 75,
        statements: 70,
      },
    },
  },
});
