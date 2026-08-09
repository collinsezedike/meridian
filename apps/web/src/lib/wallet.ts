import {
  isConnected,
  isAllowed,
  requestAccess,
  signTransaction as freighterSign,
} from "@stellar/freighter-api";

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
    const mock = mockWallet();
    if (mock) return mock.installed;
    const result = await isConnected();
    return result.isConnected;
  }

  async isAuthorized(): Promise<boolean> {
    const mock = mockWallet();
    if (mock) return mock.installed && mock.authorized;
    const installed = await this.isInstalled();
    if (!installed) return false;
    const result = await isAllowed();
    return result.isAllowed;
  }

  async connect(): Promise<string> {
    const mock = mockWallet();
    if (mock) return mock.address;
    const result = await requestAccess();
    if (result.error) throw new Error(result.error.message);
    return result.address;
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const mock = mockWallet();
    if (mock) return mock.sign(xdr, networkPassphrase);
    const result = await freighterSign(xdr, { networkPassphrase });
    if (result.error) throw new Error(result.error.message);
    if (!result.signedTxXdr) throw new Error("Signing cancelled");
    return result.signedTxXdr;
  }
}

// Freighter is the only supported wallet today.
export const wallet: WalletAdapter = new FreighterWallet();
