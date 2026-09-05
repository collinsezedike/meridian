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
import { xBullWalletConnect } from "@creit.tech/xbull-wallet-connect";

// Closing the Albedo popup does not reject the request the way a genuine
// failure does: @albedo-link/intent's transportCloseHandler() resolves every
// pending request with intentErrors.actionRejectedByUser
// ({ message: "Action request was rejected by the user.", code: -4 }, no
// `.error` field), since handleIntentResponsePromise only rejects when
// `.error` is present. A successful response never carries `code`, so its
// presence (specifically -4) is what distinguishes a user cancellation from
// a real failure on an otherwise-empty result.
const ALBEDO_USER_REJECTED_CODE = -4;

type AlbedoModule = {
  publicKey: (params: Record<string, unknown>) => Promise<{
    pubkey?: string;
    signed_message?: string;
    signature?: string;
    code?: number;
    message?: string;
  }>;
  tx: (params: {
    xdr: string;
    network?: string;
    submit?: boolean;
    pubkey?: string;
  }) => Promise<{
    signed_envelope_xdr?: string;
    xdr?: string;
    tx_hash?: string;
    network?: string;
    result?: unknown;
    code?: number;
    message?: string;
  }>;
};

async function getAlbedo(): Promise<AlbedoModule> {
  try {
    const mod = (await import("@albedo-link/intent")) as unknown as {
      default: AlbedoModule;
    } & AlbedoModule;
    return (mod.default ?? mod) as AlbedoModule;
  } catch {
    return {
      publicKey: async () => {
        throw new Error("Albedo not available");
      },
      tx: async () => {
        throw new Error("Albedo not available");
      },
    };
  }
}

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

// Shared by every wallet whose API offers no passive "is site authorized"
// query (LOBSTR, xBull, Albedo): each stores its own paired-public-key signal
// in sessionStorage under a wallet-specific key, set on connect() and read by
// isAuthorized(). Session scope means a returning browser session
// re-validates against the extension instead of trusting a stale key from a
// previous session.
function readStoredPublicKey(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(storageKey);
}

function storePublicKey(storageKey: string, publicKey: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(storageKey, publicKey);
}

const LOBSTR_PUBLIC_KEY_STORAGE_KEY = "meridian-lobstr-public-key";

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
        return readStoredPublicKey(LOBSTR_PUBLIC_KEY_STORAGE_KEY) !== null;
      }
    );
  }

  async connect(): Promise<string> {
    return withMockWallet(
      (mock) => mock.address,
      async () => {
        const publicKey = await lobstrGetPublicKey();
        if (!publicKey) throw new Error("LOBSTR wallet returned no public key");
        storePublicKey(LOBSTR_PUBLIC_KEY_STORAGE_KEY, publicKey);
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

// xBull's own public key/pairing signal, kept separate from LOBSTR's.
const XBULL_PUBLIC_KEY_STORAGE_KEY = "meridian-xbull-public-key";

// The extension injects this global for its own "direct" SDK (separate from
// the xbull-wallet-connect bridge library used below for connect/sign). Its
// presence is the only passive signal xBull exposes for "is the extension
// installed" — the bridge library itself has no isConnected-style query and
// will silently fall back to opening the xBull webapp if the extension is
// absent.
function isXBullExtensionPresent(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof (window as unknown as { xBullSDK?: unknown }).xBullSDK !==
    "undefined"
  );
}

// xBull talks to the extension (or the xBull webapp, as a fallback) through
// the xbull-wallet-connect bridge library via postMessage, not a browser-
// injected request/response API like Freighter's. That means:
//   1. isInstalled() can't ask the bridge; it checks for window.xBullSDK
//      instead (see isXBullExtensionPresent above).
//   2. isAuthorized() has no passive query either, so — same as LobstrWallet —
//      it's "extension installed + a public key stored from a prior connect()".
// Each connect()/sign() call opens a fresh bridge, per the library's own
// guidance, and always closes it via closeConnections() in a finally block to
// avoid leaking listeners into the next bridge instance.
export class XBullWallet implements WalletAdapter {
  async isInstalled(): Promise<boolean> {
    return withMockWallet(
      (mock) => mock.installed,
      async () => isXBullExtensionPresent()
    );
  }

  async isAuthorized(): Promise<boolean> {
    return withMockWallet(
      (mock) => mock.installed && mock.authorized,
      async () => {
        const installed = await this.isInstalled();
        if (!installed) return false;
        return readStoredPublicKey(XBULL_PUBLIC_KEY_STORAGE_KEY) !== null;
      }
    );
  }

  async connect(): Promise<string> {
    return withMockWallet(
      (mock) => mock.address,
      async () => {
        const bridge = new xBullWalletConnect();
        try {
          const publicKey = await bridge.connect();
          if (!publicKey)
            throw new Error("xBull wallet returned no public key");
          storePublicKey(XBULL_PUBLIC_KEY_STORAGE_KEY, publicKey);
          return publicKey;
        } finally {
          bridge.closeConnections();
        }
      }
    );
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    return withMockWallet(
      (mock) => mock.sign(xdr, networkPassphrase),
      async () => {
        const bridge = new xBullWalletConnect();
        try {
          const signedXdr = await bridge.sign({
            xdr,
            network: networkPassphrase,
            publicKey:
              readStoredPublicKey(XBULL_PUBLIC_KEY_STORAGE_KEY) ?? undefined,
          });
          if (!signedXdr) throw new Error("Signing cancelled");
          return signedXdr;
        } finally {
          bridge.closeConnections();
        }
      }
    );
  }
}

// Albedo is a web-based Stellar signer that authorizes through a popup at
// albedo.link. Unlike extension wallets it needs no install, so
// isInstalled() is always true and the popup flow itself is the install
// check. It has no passive "is site authorized" query without prompting, so
// isAuthorized() is treated the same way as for LOBSTR/xBull: installed plus
// a public key stored by a prior connect(). The key is kept in sessionStorage
// so a returning session re-validates instead of trusting a stale value.
const ALBEDO_PUBLIC_KEY_STORAGE_KEY = "meridian-albedo-public-key";

function albedoNetworkFromPassphrase(passphrase: string): string {
  if (passphrase === "Public Global Stellar Network ; September 2015")
    return "public";
  if (passphrase === "Test SDF Network ; September 2015") return "testnet";
  return passphrase;
}

export class AlbedoWallet implements WalletAdapter {
  async isInstalled(): Promise<boolean> {
    return withMockWallet(
      (mock) => mock.installed,
      async () => true
    );
  }

  // Albedo's API has no non-prompting "is site authorized" query. Calling
  // publicKey() would open the Albedo popup, which must not happen on every
  // tab focus (store/wallet.ts revalidate() runs isAuthorized on mount and
  // focus). Treat "installed + a public key stored by a prior connect()" as
  // authorized instead.
  async isAuthorized(): Promise<boolean> {
    return withMockWallet(
      (mock) => mock.installed && mock.authorized,
      async () => {
        const installed = await this.isInstalled();
        if (!installed) return false;
        return readStoredPublicKey(ALBEDO_PUBLIC_KEY_STORAGE_KEY) !== null;
      }
    );
  }

  async connect(): Promise<string> {
    return withMockWallet(
      (mock) => mock.address,
      async () => {
        const albedo = await getAlbedo();
        const result = await albedo.publicKey({});
        if (result?.code === ALBEDO_USER_REJECTED_CODE) {
          throw new Error("Connection cancelled");
        }
        if (!result?.pubkey)
          throw new Error("Albedo wallet returned no public key");
        storePublicKey(ALBEDO_PUBLIC_KEY_STORAGE_KEY, result.pubkey);
        return result.pubkey;
      }
    );
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    return withMockWallet(
      (mock) => mock.sign(xdr, networkPassphrase),
      async () => {
        const albedo = await getAlbedo();
        const network = albedoNetworkFromPassphrase(networkPassphrase);
        const result = await albedo.tx({ xdr, network, submit: false });
        if (!result?.signed_envelope_xdr) throw new Error("Signing cancelled");
        return result.signed_envelope_xdr;
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Wallet registry (#611)
// ---------------------------------------------------------------------------

export type WalletId = "freighter" | "lobstr" | "xbull" | "albedo";

export interface WalletMeta {
  id: WalletId;
  name: string;
  // Where to send a user who picks this wallet but doesn't have it
  // installed. Both are the wallet's own general site rather than a
  // store-specific deep link, matching how freighter.app was already used
  // here before this wallet became one of several.
  installUrl: string;
  adapter: WalletAdapter;
}

// Every implemented adapter, in the order offered to the user.
export const WALLETS: WalletMeta[] = [
  {
    id: "freighter",
    name: "Freighter",
    installUrl: "https://freighter.app",
    adapter: new FreighterWallet(),
  },
  {
    id: "lobstr",
    name: "LOBSTR",
    installUrl: "https://lobstr.co",
    adapter: new LobstrWallet(),
  },
  {
    id: "xbull",
    name: "xBull",
    installUrl: "https://xbull.app",
    adapter: new XBullWallet(),
  },
  // AlbedoWallet is implemented and tested but deliberately not wired in
  // here yet: wallet-picker UI exposure is out of scope for the PR that
  // added it (#674), gated on #611 landing separately.
];

const DEFAULT_WALLET_ID: WalletId = "freighter";
const SELECTED_WALLET_STORAGE_KEY = "meridian-selected-wallet";

export function isWalletId(value: string | null): value is WalletId {
  return WALLETS.some((w) => w.id === value);
}

/** The user's last-picked wallet, persisted across sessions. Defaults to Freighter. */
export function getSelectedWalletId(): WalletId {
  if (typeof window === "undefined") return DEFAULT_WALLET_ID;
  const stored = window.localStorage.getItem(SELECTED_WALLET_STORAGE_KEY);
  return isWalletId(stored) ? stored : DEFAULT_WALLET_ID;
}

export function setSelectedWalletId(id: WalletId): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SELECTED_WALLET_STORAGE_KEY, id);
}

export function getWalletMeta(id: WalletId): WalletMeta {
  return WALLETS.find((w) => w.id === id) ?? WALLETS[0]!;
}

export function getWalletAdapter(id: WalletId): WalletAdapter {
  return getWalletMeta(id).adapter;
}

// Back-compat dispatcher: resolves to whichever wallet is currently
// selected on every call, rather than being pinned to one adapter. Callers
// that only ever need "the wallet the user is connected through" (signing,
// re-authorization checks) keep using this and automatically follow the
// user's choice; callers that need to act on a *specific* wallet before it
// becomes the selection (the connect picker) use getWalletAdapter directly.
export const wallet: WalletAdapter = {
  isInstalled: () => getWalletAdapter(getSelectedWalletId()).isInstalled(),
  isAuthorized: () => getWalletAdapter(getSelectedWalletId()).isAuthorized(),
  connect: () => getWalletAdapter(getSelectedWalletId()).connect(),
  sign: (xdr, networkPassphrase) =>
    getWalletAdapter(getSelectedWalletId()).sign(xdr, networkPassphrase),
};
