import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**"],
      thresholds: {
        lines: 70,
        // Restored after #332 added coverage for coordinator.ts and
        // simulateView (measured branch coverage is 76.66% as of that PR;
        // a small margin below that keeps CI from flaking on minor drift).
        branches: 76,
        functions: 70,
        statements: 70,
      },
    },
  },
});
