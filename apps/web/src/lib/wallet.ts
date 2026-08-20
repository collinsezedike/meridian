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
  real: () => T | Promise<T>
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

// The LOBSTR API itself persists the pairing connection key in sessionStorage
// (signTransaction/signMessage read it from there), so we store our own
// paired-public-key signal in the same scope. Session scope means a returning
// browser session re-validates against the extension instead of trusting a
// stale key from a previous session.
const LOBSTR_PUBLIC_KEY_STORAGE_KEY = "meridian-lobstr-public-key";

function readStoredLobstrPublicKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(LOBSTR_PUBLIC_KEY_STORAGE_KEY);
}

function storeLobstrPublicKey(publicKey: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(LOBSTR_PUBLIC_KEY_STORAGE_KEY, publicKey);
}

// LOBSTR uses a browser extension that pairs with the LOBSTR mobile app.
// It differs from Freighter in two ways:
//   1. There is no separate site-permission query. isConnected() only
//      confirms the extension is installed — the extension's
//      REQUEST_CONNECTION_STATUS handler returns true unconditionally. Pairing
//      is established via getPublicKey(), which opens the grant-access popup
//      and resolves with a public key only after the user approves a paired
//      account.
//   2. signTransaction() takes only the XDR; the extension derives the network
//      from its own pairing with the mobile app.
export class LobstrWallet implements WalletAdapter {
  async isInstalled(): Promise<boolean> {
    return withMockWallet((mock) => mock.installed, lobstrIsConnected);
  }

  // LOBSTR's API offers no passive "is site authorized" query like Freighter's
  // isAllowed(). The only way to learn the paired public key is getPublicKey(),
  // which prompts, so calling it here would pop the grant-access dialog on every
  // tab focus (store/wallet.ts revalidate() runs this on mount and on focus).
  // Treat "extension installed + a public key stored by a prior connect()" as
  // authorized instead. This cannot detect a revocation made inside the
  // extension since the last connect(), but LOBSTR exposes no non-prompting
  // signal for that.
  async isAuthorized(): Promise<boolean> {
    return withMockWallet(
      (mock) => mock.installed && mock.authorized,
      async () => {
        const installed = await this.isInstalled();
        if (!installed) return false;
        return readStoredLobstrPublicKey() !== null;
      }
    );
  }

  async connect(): Promise<string> {
    return withMockWallet(
      (mock) => mock.address,
      async () => {
        const publicKey = await lobstrGetPublicKey();
        if (!publicKey) throw new Error("LOBSTR wallet returned no public key");
        storeLobstrPublicKey(publicKey);
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
