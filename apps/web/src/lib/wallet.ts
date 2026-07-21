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

export async function isFreighterInstalled(): Promise<boolean> {
  const mock = mockWallet();
  if (mock) return mock.installed;
  const result = await isConnected();
  return result.isConnected;
}

// Checks whether the user has granted this site access in Freighter.
// Returns false if the extension is absent or the site permission was revoked.
export async function isFreighterAuthorized(): Promise<boolean> {
  const mock = mockWallet();
  if (mock) return mock.installed && mock.authorized;
  const installed = await isFreighterInstalled();
  if (!installed) return false;
  const result = await isAllowed();
  return result.isAllowed;
}

export async function connectFreighter(): Promise<string> {
  const mock = mockWallet();
  if (mock) return mock.address;
  const result = await requestAccess();
  if (result.error) throw new Error(result.error.message);
  return result.address;
}

export async function signTransaction(
  xdr: string,
  networkPassphrase: string
): Promise<string> {
  const mock = mockWallet();
  if (mock) return mock.sign(xdr, networkPassphrase);
  const result = await freighterSign(xdr, { networkPassphrase });
  if (result.error) throw new Error(result.error.message);
  if (!result.signedTxXdr) throw new Error("Signing cancelled");
  return result.signedTxXdr;
}
