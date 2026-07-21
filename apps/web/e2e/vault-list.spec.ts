import { test, expect } from "./fixtures";

test.describe("vault list", () => {
  test("renders live APY, TVL, and route from the real API", async ({
    page,
  }) => {
    await page.goto("./");

    // No wallet needed — the vault stats come from GET /api/v1/vaults
    // regardless of connection state. The stats row shows a loading skeleton
    // (no text) until the real API call resolves, which can take a few
    // seconds on a freshly-booted server, hence the generous timeouts.
    await expect(page.getByText("APY")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("TVL")).toBeVisible();
    await expect(page.getByText("Route")).toBeVisible();

    // The APY value renders as a number once the vaults query resolves —
    // confirms the real api-local -> stellar-sdk-helpers -> DeFiLlama/RPC
    // chain returned usable data, not just that the labels rendered.
    await expect(page.locator("text=/\\d+\\.\\d{2}/").first()).toBeVisible();
  });
});
