import { defineConfig, devices } from "@playwright/test";

// Runs against the real dev stack: apps/web (vite, :3000) proxying /api to
// apps/api-local (fastify, :3001), both booted automatically. Wallet
// connect/sign is exercised through the __E2E_MOCK_WALLET__ seam in
// src/lib/wallet.ts rather than a real Freighter extension — see e2e/fixtures.ts.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000/app/",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @meridian/api-local dev",
      url: "http://localhost:3001/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @meridian/web dev",
      url: "http://localhost:3000/app/",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
