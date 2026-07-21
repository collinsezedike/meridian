import { test, expect, TEST_ADDRESS } from "./fixtures";

test.describe("wallet connect", () => {
  test("prompts to connect when no wallet is linked", async ({ page }) => {
    await page.goto("./");
    await expect(
      page.getByText(/Connect your Freighter wallet/i)
    ).toBeVisible();
    await expect(page.getByTestId("vault-tab-deposit")).toHaveCount(0);
  });

  test("connects through the wallet-connect button", async ({
    page,
    mockWallet,
  }) => {
    await mockWallet();
    await page.goto("./");

    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();

    // Header switches to the connected pill showing the shortened address.
    await expect(page.getByText("GBBD...FLA5")).toBeVisible();
    // Deposit/withdraw tabs only render once connected.
    await expect(page.getByTestId("vault-tab-deposit")).toBeVisible();
  });

  test("shows the install prompt when the extension isn't present", async ({
    page,
    mockWallet,
  }) => {
    await mockWallet({ installed: false });
    await page.goto("./");

    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();

    await expect(
      page.getByRole("link", { name: "Install Freighter" })
    ).toBeVisible();
  });

  test("restores a persisted connection across reloads", async ({
    page,
    mockWallet,
  }) => {
    await mockWallet();
    await page.goto("./");
    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();
    await expect(page.getByText("GBBD...FLA5")).toBeVisible();

    await page.reload();

    await expect(page.getByText("GBBD...FLA5")).toBeVisible();
  });
});

test.describe("wallet address", () => {
  test("uses the configured test address", () => {
    expect(TEST_ADDRESS).toMatch(/^G[A-Z2-7]{55}$/);
  });
});
