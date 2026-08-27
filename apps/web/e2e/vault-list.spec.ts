import { test, expect } from "./fixtures";

test.describe("vault list", () => {
  test("renders APY, TVL, and route for the recommended vault", async ({
    page,
  }) => {
    // The vaults endpoint hits real testnet RPC on every request, which is
    // flaky in CI (see #535). Stub it with deterministic data so this spec
    // exercises the UI without depending on live testnet RPC availability.
    await page.route("**/api/v1/vaults", (route) => {
      return route.fulfill({
        json: {
          vaults: [
            {
              id: "meridian-usdc",
              protocol: "meridian",
              asset: "USDC",
              name: "Meridian",
              label: "USDC Vault",
              apy: 5.25,
              tvl: 1234567,
              userBalance: 0,
              riskLevel: "safe",
            },
          ],
          recommendedVaultId: "meridian-usdc",
          updatedAt: new Date().toISOString(),
          cached: false,
        },
      });
    });

    await page.goto("./");

    // The stats row renders the recommended vault's APY (5.25%), TVL
    // ($1.2M), and route ("Meridian" protocol label).
    await expect(page.getByText("APY")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("TVL")).toBeVisible();
    await expect(page.getByText("Route")).toBeVisible();
    await expect(page.getByText("5.25")).toBeVisible();
    await expect(page.getByText("$1.2M")).toBeVisible();
  });
});
