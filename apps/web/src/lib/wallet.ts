import {
  isConnected,
  isAllowed,
  requestAccess,
  signTransaction as freighterSign,
} from "@stellar/freighter-api";
import {
  isConnected as lobstrIsConnected,
  getPublicKey as lobstrGetPublicKey,
  signTransaction as lobstrSign,
} from "@lobstrco/signer-extension-api";

// Freighter's real API talks to the browser extension via an internal
// postMessage protocol, which isn't practical to fake from outside the app.
// Playwright e2e tests inject this global before the app loads (see
// apps/web/e2e/fixtures.ts) to exercise the connect/sign code paths without
// a real extension. Always undefined outside of e2e runs.
export interface E2EMockWallet {
  installed: boolean;
  authorized: boolean;
  address: string;
  sign: (xdr: string, networkPassphrase: string) => Promise<string>;
}

declare global {
  interface Window {
    __E2E_MOCK_WALLET__?: E2EMockWallet;
  }
}

function mockWallet(): E2EMockWallet | undefined {
  return typeof window !== "undefined" ? window.__E2E_MOCK_WALLET__ : undefined;
}

/**
 * Runs `real` unless the e2e mock wallet is present, in which case it runs
 * `mocked` instead. Every adapter method short-circuits through this so the
 * `const mock = mockWallet(); if (mock) ...` dance lives in one place instead
 * of being duplicated in each wallet adapter.
 */
async function withMockWallet<T>(
  mocked: (mock: E2EMockWallet) => T | Promise<T>,
  real: () => T | Promise<T>,
): Promise<T> {
  const mock = mockWallet();
  if (mock) return mocked(mock);
  return real();
}

/**
 * Common interface every supported wallet implements. Call sites depend on
 * this, not on any wallet-specific API, so adding a wallet means adding an
 * implementation and selecting it below, not touching callers.
 */
export interface WalletAdapter {
  isInstalled(): Promise<boolean>;
  // Whether the user has granted this site access. False if the wallet is
  // absent or the site permission was revoked.
  isAuthorized(): Promise<boolean>;
  connect(): Promise<string>;
  sign(xdr: string, networkPassphrase: string): Promise<string>;
}

class FreighterWallet implements WalletAdapter {
  async isInstalled(): Promise<boolean> {
    return withMockWallet(
      (mock) => mock.installed,
      async () => {
        const result = await isConnected();
        return result.isConnected;
      }
    );
  }

  async isAuthorized(): Promise<boolean> {
    return withMockWallet(
      (mock) => mock.installed && mock.authorized,
      async () => {
        const installed = await this.isInstalled();
        if (!installed) return false;
        const result = await isAllowed();
        return result.isAllowed;
      }
    );
  }

  async connect(): Promise<string> {
    return withMockWallet(
      (mock) => mock.address,
      async () => {
        const result = await requestAccess();
        if (result.error) throw new Error(result.error.message);
        return result.address;
      }
    );
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    return withMockWallet(
      (mock) => mock.sign(xdr, networkPassphrase),
      async () => {
        const result = await freighterSign(xdr, { networkPassphrase });
        if (result.error) throw new Error(result.error.message);
        if (!result.signedTxXdr) throw new Error("Signing cancelled");
        return result.signedTxXdr;
      }
    );
  }
}

// LOBSTR uses a browser extension that pairs with the LOBSTR mobile app.
// It differs from Freighter in two ways:
//   1. There is no separate site-permission query. isConnected() only
//      confirms the extension is installed — the extension's
//      REQUEST_CONNECTION_STATUS handler returns true unconditionally — so
//      pairing/authorization is checked via getPublicKey(), which opens the
//      grant-access popup and resolves with a public key only after the user
//      approves a paired account.
//   2. signTransaction() takes only the XDR; the extension derives the network
//      from its own pairing with the mobile app.
export class LobstrWallet implements WalletAdapter {
  async isInstalled(): Promise<boolean> {
    return withMockWallet((mock) => mock.installed, lobstrIsConnected);
  }

  // LOBSTR's API offers no way to check mobile-app pairing without prompting.
  // isConnected() only confirms the extension is installed, so the install
  // check is delegated to isInstalled(). The only real pairing check is
  // getPublicKey(), which opens the extension's grant-access popup and
  // resolves with a public key only after the user approves a paired account.
  // Treat a resolved key as authorized; a missing or unpaired extension (no
  // key, or a declined/error response) means no access.
  async isAuthorized(): Promise<boolean> {
    return withMockWallet(
      (mock) => mock.installed && mock.authorized,
      async () => {
        const installed = await this.isInstalled();
        if (!installed) return false;
        try {
          const publicKey = await lobstrGetPublicKey();
          return Boolean(publicKey);
        } catch {
          return false;
        }
      }
    );
  }

  async connect(): Promise<string> {
    return withMockWallet(
      (mock) => mock.address,
      async () => {
        const publicKey = await lobstrGetPublicKey();
        if (!publicKey) throw new Error("LOBSTR wallet returned no public key");
        return publicKey;
      }
    );
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    return withMockWallet(
      (mock) => mock.sign(xdr, networkPassphrase),
      async () => {
        // LOBSTR's signTransaction does not accept a networkPassphrase; the
        // extension uses the network already configured in the paired mobile app.
        const signedXdr = await lobstrSign(xdr);
        if (!signedXdr) throw new Error("Signing cancelled");
        return signedXdr;
      }
    );
  }
}

// Freighter is the only supported wallet today.
export const wallet: WalletAdapter = new FreighterWallet();
