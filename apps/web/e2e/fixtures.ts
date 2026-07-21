import { test as base, expect, type Page } from "@playwright/test";

// A syntactically valid-looking but not-actually-funded testnet address.
// Horizon returns 404 for it, which the app's balance/trustline checks
// already handle gracefully (fail open), so it exercises real code paths
// without depending on a real funded account existing.
export const TEST_ADDRESS =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export interface MockWalletOptions {
  installed?: boolean;
  authorized?: boolean;
  address?: string;
  /**
   * "decline" (default) rejects every sign request, simulating the user
   * closing the Freighter popup — exercises the full build-transaction flow
   * against the real API and the app's error handling, without needing a
   * real signature or on-chain submission. "approve" resolves with a fake
   * signed XDR, which will still fail once posted to /tx/submit against the
   * real network, but lets a test assert the app got that far.
   */
  signBehavior?: "approve" | "decline";
}

type Fixtures = {
  mockWallet: (opts?: MockWalletOptions) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  mockWallet: async ({ page }, use) => {
    await use(async (opts = {}) => {
      const installed = opts.installed ?? true;
      const authorized = opts.authorized ?? true;
      const address = opts.address ?? TEST_ADDRESS;
      const signBehavior = opts.signBehavior ?? "decline";

      await page.addInitScript(
        (init: {
          installed: boolean;
          authorized: boolean;
          address: string;
          signBehavior: "approve" | "decline";
        }) => {
          const w = window as unknown as {
            __E2E_MOCK_WALLET__?: unknown;
            __E2E_SIGNED_XDRS__?: string[];
          };
          w.__E2E_SIGNED_XDRS__ = [];
          w.__E2E_MOCK_WALLET__ = {
            installed: init.installed,
            authorized: init.authorized,
            address: init.address,
            sign: async (xdr: string) => {
              w.__E2E_SIGNED_XDRS__!.push(xdr);
              if (init.signBehavior === "decline") {
                throw new Error("User declined access");
              }
              return `MOCK_SIGNED:${xdr}`;
            },
          };
        },
        { installed, authorized, address, signBehavior }
      );
    });
  },
});

export { expect };

/** Reads the XDRs the mock wallet was asked to sign, in call order. */
export async function getSignedXdrs(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __E2E_SIGNED_XDRS__?: string[] })
        .__E2E_SIGNED_XDRS__ ?? []
  );
}
