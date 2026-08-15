import { test, expect, getSignedXdrs } from "./fixtures";

test.describe("deposit", () => {
  test("builds a real deposit transaction against the real API", async ({
    page,
    mockWallet,
  }) => {
    // TEST_ADDRESS's real testnet trustline/funding state isn't controlled by
    // this test, so the real backend's Soroban simulation may either reject
    // the deposit (no USDC trustline) or succeed and reach the sign step,
    // which the mock wallet then declines. Either outcome exercises the real
    // trustline check, the real deposit-tx build call to api-local -> Soroban
    // RPC, and the app's error handling end to end; this test accepts both
    // rather than asserting one specific real-network-dependent outcome.
    await mockWallet();
    await page.goto("./");

    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();
    await expect(page.getByTestId("vault-tab-deposit")).toBeVisible();

    await page.getByPlaceholder("0.00").fill("10");
    await page.getByTestId("vault-deposit-submit").click();

    // Real Soroban simulation and/or a real sign-decline round trip, so a
    // generous timeout. Either path ends in an error toast, the app never
    // silently swallows a failure here.
    await expect(
      page.getByText(/User declined access|Simulation failed/)
    ).toBeVisible({ timeout: 25_000 });

    const signed = await getSignedXdrs(page);
    const declinedAfterSigning = await page
      .getByText("User declined access")
      .isVisible();
    // The two outcomes are mutually exclusive: signing only happens if the
    // build succeeded, and the decline toast only appears if signing was
    // requested at all.
    expect(declinedAfterSigning).toBe(signed.length > 0);
  });

  test("deposit button stays disabled with no amount entered", async ({
    page,
    mockWallet,
  }) => {
    await mockWallet();
    await page.goto("./");
    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();

    await expect(page.getByTestId("vault-deposit-submit")).toBeDisabled();
  });
});
