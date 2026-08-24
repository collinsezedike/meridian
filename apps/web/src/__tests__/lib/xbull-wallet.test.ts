import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { XBullWallet } from "../../lib/wallet";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// Create a fresh instance per-file so we don't share state with the singleton
// `wallet` export (which is FreighterWallet).
const xbull = new XBullWallet();

/** Inject a fake xBull SDK into window.xBullSDK. */
function stubXBullSdk(
  overrides: Partial<{
    connect: () => Promise<void>;
    getPublicKey: () => Promise<string>;
    signXDR: () => Promise<string>;
  }> = {}
) {
  const sdk = {
    connect: vi.fn(async () => undefined),
    getPublicKey: vi.fn(async () => ADDRESS),
    signXDR: vi.fn(async (_xdr: string, _opts?: unknown) => "SIGNED_XDR"),
    ...overrides,
  };
  (window as unknown as { xBullSDK?: unknown }).xBullSDK = sdk;
  return sdk;
}

afterEach(() => {
  delete (window as unknown as { __E2E_MOCK_WALLET__?: unknown })
    .__E2E_MOCK_WALLET__;
  delete (window as unknown as { xBullSDK?: unknown }).xBullSDK;
});

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("XBullWallet — real xBull path (no mock wallet present)", () => {
  it("isInstalled returns true when the SDK is present", async () => {
    stubXBullSdk();
    await expect(xbull.isInstalled()).resolves.toBe(true);
  });

  it("isInstalled returns false when the extension is absent", async () => {
    await expect(xbull.isInstalled()).resolves.toBe(false);
  });

  // xBull's SDK has no passive site-permission query. isAuthorized() is a
  // passive background check (revalidate() runs it on mount and focus), so it
  // must not call connect() or getPublicKey(), which would open the grant
  // popup. Instead, treat "installed + a public key stored by a prior
  // connect()" as authorized.
  it("isAuthorized returns true when installed and a key was stored by connect", async () => {
    stubXBullSdk();
    window.sessionStorage.setItem("meridian-xbull-public-key", ADDRESS);
    await expect(xbull.isAuthorized()).resolves.toBe(true);
  });

  it("isAuthorized returns false when installed but nothing was stored", async () => {
    stubXBullSdk();
    await expect(xbull.isAuthorized()).resolves.toBe(false);
  });

  it("isAuthorized returns false when the extension is not installed", async () => {
    await expect(xbull.isAuthorized()).resolves.toBe(false);
  });

  it("isAuthorized never calls connect or getPublicKey (passive, no prompt)", async () => {
    const sdk = stubXBullSdk();
    await xbull.isAuthorized();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.getPublicKey).not.toHaveBeenCalled();
  });

  it("connect returns the public key and remembers it for isAuthorized", async () => {
    stubXBullSdk();
    await expect(xbull.connect()).resolves.toBe(ADDRESS);
    expect(window.sessionStorage.getItem("meridian-xbull-public-key")).toBe(
      ADDRESS
    );

    // After connect, isAuthorized should return true
    await expect(xbull.isAuthorized()).resolves.toBe(true);
  });

  it("connect calls sdk.connect with both permissions", async () => {
    const sdk = stubXBullSdk();
    await xbull.connect();
    expect(sdk.connect).toHaveBeenCalledWith({
      canRequestPublicKey: true,
      canRequestSign: true,
    });
  });

  it("connect throws when the SDK is missing", async () => {
    await expect(xbull.connect()).rejects.toThrow("xBull wallet not found");
  });

  it("connect throws when getPublicKey returns an empty string", async () => {
    stubXBullSdk({ getPublicKey: async () => "" });
    await expect(xbull.connect()).rejects.toThrow(
      "xBull wallet returned no public key"
    );
  });

  it("sign returns the signed XDR on success", async () => {
    stubXBullSdk();
    await expect(xbull.sign("XDR", "passphrase")).resolves.toBe("SIGNED_XDR");
  });

  it("sign passes the networkPassphrase to signXDR", async () => {
    const sdk = stubXBullSdk();
    await xbull.sign("XDR", "Test SDF Network ; September 2015");
    expect(sdk.signXDR).toHaveBeenCalledWith("XDR", {
      network: "Test SDF Network ; September 2015",
    });
    expect(sdk.signXDR).toHaveBeenCalledTimes(1);
  });

  it("sign throws when the SDK is missing", async () => {
    await expect(xbull.sign("XDR", "passphrase")).rejects.toThrow(
      "xBull wallet not found"
    );
  });

  it("sign throws when signing is cancelled (falsy return)", async () => {
    stubXBullSdk({ signXDR: async () => "" });
    await expect(xbull.sign("XDR", "passphrase")).rejects.toThrow(
      "Signing cancelled"
    );
  });

  it("sign propagates errors thrown by the SDK", async () => {
    stubXBullSdk({
      signXDR: async () => {
        throw new Error("User rejected");
      },
    });
    await expect(xbull.sign("XDR", "passphrase")).rejects.toThrow(
      "User rejected"
    );
  });
});

describe("XBullWallet — e2e mock wallet path", () => {
  function setMockWallet(overrides: {
    installed?: boolean;
    authorized?: boolean;
    address?: string;
    sign?: (xdr: string, networkPassphrase: string) => Promise<string>;
  }) {
    (
      window as unknown as { __E2E_MOCK_WALLET__: unknown }
    ).__E2E_MOCK_WALLET__ = {
      installed: true,
      authorized: true,
      address: ADDRESS,
      sign: async () => "MOCK_SIGNED",
      ...overrides,
    };
  }

  it("short-circuits isInstalled without calling the real SDK", async () => {
    setMockWallet({ installed: false });
    await expect(xbull.isInstalled()).resolves.toBe(false);
  });

  it("short-circuits isInstalled true when mock says installed", async () => {
    setMockWallet({ installed: true });
    await expect(xbull.isInstalled()).resolves.toBe(true);
  });

  it("short-circuits isAuthorized to installed && authorized", async () => {
    setMockWallet({ installed: true, authorized: false });
    await expect(xbull.isAuthorized()).resolves.toBe(false);

    setMockWallet({ installed: false, authorized: true });
    await expect(xbull.isAuthorized()).resolves.toBe(false);

    setMockWallet({ installed: true, authorized: true });
    await expect(xbull.isAuthorized()).resolves.toBe(true);
  });

  it("short-circuits connect to the mock address", async () => {
    setMockWallet({ address: ADDRESS });
    await expect(xbull.connect()).resolves.toBe(ADDRESS);
  });

  it("short-circuits sign to the mock sign function", async () => {
    const sign = vi.fn(async (xdr: string) => `SIGNED:${xdr}`);
    setMockWallet({ sign });
    await expect(xbull.sign("XDR", "passphrase")).resolves.toBe("SIGNED:XDR");
    expect(sign).toHaveBeenCalledWith("XDR", "passphrase");
  });

  it("propagates a decline rejection from the mock sign function", async () => {
    setMockWallet({
      sign: async () => {
        throw new Error("User declined access");
      },
    });
    await expect(xbull.sign("XDR", "passphrase")).rejects.toThrow(
      "User declined access"
    );
  });
});