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

// LOBSTR uses a browser extension that pairs with the LOBSTR mobile app.
// Its model differs from Freighter in two ways:
//   1. There is no separate site-permission step — isConnected() covers both
//      "is the extension installed?" and "is the mobile app paired?".
//   2. signTransaction() takes only the XDR; the extension derives the network
//      from its own pairing with the mobile app.
export class LobstrWallet implements WalletAdapter {
  async isInstalled(): Promise<boolean> {
    const mock = mockWallet();
    if (mock) return mock.installed;
    return lobstrIsConnected();
  }

  // LOBSTR's extension provides both presence and authorization through a
  // single isConnected check — there is no separate isAllowed gate. A
  // connected extension means the user has the app paired and access is
  // granted; an absent or unpaired extension means no access.
  async isAuthorized(): Promise<boolean> {
    const mock = mockWallet();
    if (mock) return mock.installed && mock.authorized;
    return lobstrIsConnected();
  }

  async connect(): Promise<string> {
    const mock = mockWallet();
    if (mock) return mock.address;
    const publicKey = await lobstrGetPublicKey();
    if (!publicKey) throw new Error("LOBSTR wallet returned no public key");
    return publicKey;
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const mock = mockWallet();
    if (mock) return mock.sign(xdr, networkPassphrase);
    // LOBSTR's signTransaction does not accept a networkPassphrase; the
    // extension uses the network already configured in the paired mobile app.
    const signedXdr = await lobstrSign(xdr);
    if (!signedXdr) throw new Error("Signing cancelled");
    return signedXdr;
  }
}

// Freighter is the only supported wallet today.
export const wallet: WalletAdapter = new FreighterWallet();
