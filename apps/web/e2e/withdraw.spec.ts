import { test, expect, getSignedXdrs, TEST_ADDRESS } from "./fixtures";

// meridian-usdc is the real testnet-deployed coordinator vault (see
// packages/stellar-sdk-helpers/src/known-pools.ts). blend-usdc-fixed and
// similar ids only exist under KNOWN_POOLS.mainnet for display/APY purposes,
// resolveVaultEntry rejects them on testnet with "Vault not configured".
const FAKE_POSITION = {
  vaultId: "meridian-usdc",
  shares: 42,
  deposited: 42,
  earned: 1.5,
  entryTime: Math.floor(Date.now() / 1000) - 86_400,
};

test.describe("withdraw", () => {
  test("builds a real withdraw transaction against the real API", async ({
    page,
    mockWallet,
  }) => {
    // No real funded testnet position exists for TEST_ADDRESS, so the GET
    // positions read is stubbed to seed one (see FAKE_POSITION above).
    // Everything downstream is real: the withdraw tab, amount validation,
    // and the POST /api/v1/tx/withdraw build against the real testnet vault
    // contract, which correctly rejects it before signing is ever requested.
    // Which contract error comes back depends on whether *anyone* has ever
    // deposited into the live vault: InsufficientShares (#7) if the vault
    // has other depositors and only this account holds none, or
    // NoSharesOutstanding (#6) if the vault is empty of deposits entirely
    // (see MeridianVault::withdraw's total_shares <= 0 check, which runs
    // before the per-caller check). Either is the correct "nothing to
    // withdraw" rejection this test cares about, so accept both rather than
    // pin to whichever the live vault's deposit history happens to produce.
    await page.route(`**/api/v1/positions/${TEST_ADDRESS}`, (route) =>
      route.fulfill({ json: { positions: [FAKE_POSITION] } })
    );

    await mockWallet();
    await page.goto("./");

    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();
    await expect(page.getByTestId("vault-tab-deposit")).toBeVisible();

    await page.getByTestId("vault-tab-withdraw").click();
    await expect(page.getByTestId("vault-withdraw-submit")).toBeVisible();

    await page.getByPlaceholder("0.00").fill("10");
    await page.getByTestId("vault-withdraw-submit").click();

    await expect(
      page.getByText(/Simulation failed: HostError: Error\(Contract, #[67]\)/)
    ).toBeVisible({ timeout: 20_000 });

    expect(await getSignedXdrs(page)).toHaveLength(0);
  });

  test("shows the no-position message when nothing is deposited", async ({
    page,
    mockWallet,
  }) => {
    await page.route(`**/api/v1/positions/${TEST_ADDRESS}`, (route) =>
      route.fulfill({ json: { positions: [] } })
    );

    await mockWallet();
    await page.goto("./");
    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();
    await page.getByTestId("vault-tab-withdraw").click();

    await expect(
      page.getByText("You have no active position to withdraw from.")
    ).toBeVisible();
  });

  test("Max button fills the full position balance", async ({
    page,
    mockWallet,
  }) => {
    await page.route(`**/api/v1/positions/${TEST_ADDRESS}`, (route) =>
      route.fulfill({ json: { positions: [FAKE_POSITION] } })
    );

    await mockWallet();
    await page.goto("./");
    await page
      .locator("main")
      .getByRole("button", { name: "Connect Wallet" })
      .click();
    await page.getByTestId("vault-tab-withdraw").click();

    await page.getByTestId("vault-withdraw-max").click();
    await expect(page.getByPlaceholder("0.00")).toHaveValue("42.0000000");
  });
});
