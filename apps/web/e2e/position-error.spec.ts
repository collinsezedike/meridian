import { test, expect, TEST_ADDRESS } from "./fixtures";

test.describe("position load error", () => {
  test("shows a retry banner and recovers once the API succeeds", async ({
    page,
    mockWallet,
  }) => {
    // usePositions has retry: 1, so the initial fetch plus its automatic
    // retry both need to fail before the UI settles into the error state;
    // only the user-triggered retry (the 3rd request) should succeed.
    let requestCount = 0;
    await page.route(`**/api/v1/positions/${TEST_ADDRESS}`, (route) => {
      requestCount++;
      if (requestCount <= 2) {
        return route.fulfill({
          status: 503,
          json: { error: "Failed to read positions" },
        });
      }
      return route.fulfill({ json: { positions: [] } });
    });

    await mockWallet();
    await page.goto("./");
    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();

    await expect(
      page.getByText(
        "Couldn't load your position. Deposits and withdrawals still work."
      )
    ).toBeVisible();

    // Deposit stays usable while the position read is failing.
    await expect(page.getByTestId("vault-tab-deposit")).toBeVisible();
    await expect(page.getByTestId("vault-deposit-submit")).toBeVisible();

    await page.getByRole("button", { name: "Retry" }).click();

    await expect(
      page.getByText(
        "Couldn't load your position. Deposits and withdrawals still work."
      )
    ).not.toBeVisible();
    expect(requestCount).toBeGreaterThanOrEqual(3);
  });
});
