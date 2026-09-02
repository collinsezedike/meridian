import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@creit.tech/xbull-wallet-connect", () => ({
  xBullWalletConnect: vi.fn(),
}));

import { xBullWalletConnect } from "@creit.tech/xbull-wallet-connect";
import { XBullWallet } from "../../lib/wallet";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// Create a fresh instance per-file so we don't share state with the singleton
// `wallet` export (which is FreighterWallet).
const xbull = new XBullWallet();

function setXBullSDKPresent(present: boolean) {
  if (present) {
    (window as unknown as { xBullSDK?: unknown }).xBullSDK = {};
  } else {
    delete (window as unknown as { xBullSDK?: unknown }).xBullSDK;
  }
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
  it("isInstalled returns true when window.xBullSDK is present", async () => {
    setXBullSDKPresent(true);
    await expect(xbull.isInstalled()).resolves.toBe(true);
  });

  it("isInstalled returns false when window.xBullSDK is absent", async () => {
    setXBullSDKPresent(false);
    await expect(xbull.isInstalled()).resolves.toBe(false);
  });

  // xBull's bridge library has no isConnected-style passive query at all —
  // the only signal available without prompting is window.xBullSDK. Like
  // LobstrWallet, isAuthorized() must not open the bridge (that would pop a
  // connect prompt on every mount/focus revalidate), so it treats "extension
  // installed + a public key stored by a prior connect()" as authorized.
  it("isAuthorized returns true when installed and a key was stored by connect", async () => {
    setXBullSDKPresent(true);
    window.sessionStorage.setItem("meridian-xbull-public-key", ADDRESS);
    await expect(xbull.isAuthorized()).resolves.toBe(true);
    expect(xBullWalletConnect).not.toHaveBeenCalled();
  });

  it("isAuthorized returns false when installed but nothing was stored", async () => {
    setXBullSDKPresent(true);
    await expect(xbull.isAuthorized()).resolves.toBe(false);
    expect(xBullWalletConnect).not.toHaveBeenCalled();
  });

  it("isAuthorized returns false when window.xBullSDK is absent", async () => {
    setXBullSDKPresent(false);
    window.sessionStorage.setItem("meridian-xbull-public-key", ADDRESS);
    await expect(xbull.isAuthorized()).resolves.toBe(false);
    expect(xBullWalletConnect).not.toHaveBeenCalled();
  });

  it("isAuthorized never opens a bridge connection (passive, no prompt)", async () => {
    setXBullSDKPresent(true);
    await xbull.isAuthorized();
    expect(xBullWalletConnect).not.toHaveBeenCalled();
  });

  it("connect returns the public key, stores it, and closes the bridge", async () => {
    const connect = vi.fn().mockResolvedValue(ADDRESS);
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { connect, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
    });

    await expect(xbull.connect()).resolves.toBe(ADDRESS);
    expect(window.sessionStorage.getItem("meridian-xbull-public-key")).toBe(
      ADDRESS
    );
    expect(closeConnections).toHaveBeenCalledTimes(1);

    setXBullSDKPresent(true);
    await expect(xbull.isAuthorized()).resolves.toBe(true);
  });

  it("connect throws when the bridge returns an empty public key", async () => {
    const connect = vi.fn().mockResolvedValue("");
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { connect, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
    });

    await expect(xbull.connect()).rejects.toThrow(
      "xBull wallet returned no public key"
    );
    expect(closeConnections).toHaveBeenCalledTimes(1);
  });

  it("connect still closes the bridge when the bridge rejects", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("User rejected"));
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { connect, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
    });

    await expect(xbull.connect()).rejects.toThrow("User rejected");
    expect(closeConnections).toHaveBeenCalledTimes(1);
  });

  it("sign returns the signed XDR and closes the bridge", async () => {
    const sign = vi.fn().mockResolvedValue("SIGNED_XDR");
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { sign, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
    });

    await expect(xbull.sign("XDR", "passphrase")).resolves.toBe("SIGNED_XDR");
    expect(closeConnections).toHaveBeenCalledTimes(1);
  });

  it("sign passes xdr, network, and the stored public key to the bridge", async () => {
    window.sessionStorage.setItem("meridian-xbull-public-key", ADDRESS);
    const sign = vi.fn().mockResolvedValue("SIGNED_XDR");
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { sign, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
    });

    await xbull.sign("XDR", "passphrase");
    expect(sign).toHaveBeenCalledWith({
      xdr: "XDR",
      network: "passphrase",
      publicKey: ADDRESS,
    });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("sign passes undefined publicKey when nothing was stored yet", async () => {
    const sign = vi.fn().mockResolvedValue("SIGNED_XDR");
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { sign, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
    });

    await xbull.sign("XDR", "passphrase");
    expect(sign).toHaveBeenCalledWith({
      xdr: "XDR",
      network: "passphrase",
      publicKey: undefined,
    });
  });

  it("sign throws when signing is cancelled (falsy return)", async () => {
    const sign = vi.fn().mockResolvedValue("");
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { sign, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
    });

    await expect(xbull.sign("XDR", "passphrase")).rejects.toThrow(
      "Signing cancelled"
    );
    expect(closeConnections).toHaveBeenCalledTimes(1);
  });

  it("sign still closes the bridge when the bridge rejects", async () => {
    const sign = vi.fn().mockRejectedValue(new Error("Signing cancelled"));
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { sign, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
    });

    await expect(xbull.sign("XDR", "passphrase")).rejects.toThrow(
      "Signing cancelled"
    );
    expect(closeConnections).toHaveBeenCalledTimes(1);
  });

  it("sign propagates errors thrown by the bridge", async () => {
    const sign = vi.fn().mockRejectedValue(new Error("User rejected"));
    const closeConnections = vi.fn();
    vi.mocked(xBullWalletConnect).mockImplementation(function () {
      return { sign, closeConnections } as unknown as InstanceType<
        typeof xBullWalletConnect
      >;
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

  it("short-circuits isInstalled without calling the real API", async () => {
    setMockWallet({ installed: false });
    await expect(xbull.isInstalled()).resolves.toBe(false);
    expect(xBullWalletConnect).not.toHaveBeenCalled();
  });

  it("short-circuits isInstalled true when mock says installed", async () => {
    setMockWallet({ installed: true });
    await expect(xbull.isInstalled()).resolves.toBe(true);
    expect(xBullWalletConnect).not.toHaveBeenCalled();
  });

  it("short-circuits isAuthorized to installed && authorized", async () => {
    setMockWallet({ installed: true, authorized: false });
    await expect(xbull.isAuthorized()).resolves.toBe(false);

    setMockWallet({ installed: false, authorized: true });
    await expect(xbull.isAuthorized()).resolves.toBe(false);

    setMockWallet({ installed: true, authorized: true });
    await expect(xbull.isAuthorized()).resolves.toBe(true);

    expect(xBullWalletConnect).not.toHaveBeenCalled();
  });

  it("short-circuits connect to the mock address", async () => {
    setMockWallet({ address: ADDRESS });
    await expect(xbull.connect()).resolves.toBe(ADDRESS);
    expect(xBullWalletConnect).not.toHaveBeenCalled();
  });

  it("short-circuits sign to the mock sign function", async () => {
    const sign = vi.fn(async (xdr: string) => `SIGNED:${xdr}`);
    setMockWallet({ sign });
    await expect(xbull.sign("XDR", "passphrase")).resolves.toBe("SIGNED:XDR");
    expect(sign).toHaveBeenCalledWith("XDR", "passphrase");
    expect(xBullWalletConnect).not.toHaveBeenCalled();
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
