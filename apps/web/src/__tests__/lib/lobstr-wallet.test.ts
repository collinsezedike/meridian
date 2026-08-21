import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lobstrco/signer-extension-api", () => ({
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  signTransaction: vi.fn(),
}));

import {
  isConnected as lobstrIsConnected,
  getPublicKey as lobstrGetPublicKey,
  signTransaction as lobstrSign,
} from "@lobstrco/signer-extension-api";
import { LobstrWallet } from "../../lib/wallet";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// Create a fresh instance per-file so we don't share state with the singleton
// `wallet` export (which is FreighterWallet).
const lobstr = new LobstrWallet();

afterEach(() => {
  delete (window as unknown as { __E2E_MOCK_WALLET__?: unknown })
    .__E2E_MOCK_WALLET__;
});

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("LobstrWallet — real LOBSTR path (no mock wallet present)", () => {
  it("isInstalled returns true when the extension is connected", async () => {
    vi.mocked(lobstrIsConnected).mockResolvedValue(true);
    await expect(lobstr.isInstalled()).resolves.toBe(true);
  });

  it("isInstalled returns false when the extension is absent", async () => {
    vi.mocked(lobstrIsConnected).mockResolvedValue(false);
    await expect(lobstr.isInstalled()).resolves.toBe(false);
  });

  // LOBSTR's API has no separate site-permission query: isConnected() only
  // confirms the extension is installed (its REQUEST_CONNECTION_STATUS handler
  // returns true unconditionally). isAuthorized() is a passive background check
  // (revalidate() runs it on mount and focus), so it must not call
  // getPublicKey(), which opens the grant-access popup. Instead it treats
  // "installed + a public key stored by a prior connect()" as authorized.
  it("isAuthorized returns true when installed and a key was stored by connect", async () => {
    vi.mocked(lobstrIsConnected).mockResolvedValue(true);
    window.sessionStorage.setItem("meridian-lobstr-public-key", ADDRESS);
    await expect(lobstr.isAuthorized()).resolves.toBe(true);
    expect(lobstrGetPublicKey).not.toHaveBeenCalled();
  });

  it("isAuthorized returns false when installed but nothing was stored", async () => {
    vi.mocked(lobstrIsConnected).mockResolvedValue(true);
    await expect(lobstr.isAuthorized()).resolves.toBe(false);
    expect(lobstrGetPublicKey).not.toHaveBeenCalled();
  });

  it("isAuthorized returns false when the extension is not installed", async () => {
    vi.mocked(lobstrIsConnected).mockResolvedValue(false);
    await expect(lobstr.isAuthorized()).resolves.toBe(false);
    expect(lobstrGetPublicKey).not.toHaveBeenCalled();
  });

  it("isAuthorized never calls getPublicKey (passive, no prompt)", async () => {
    vi.mocked(lobstrIsConnected).mockResolvedValue(true);
    await lobstr.isAuthorized();
    expect(lobstrGetPublicKey).not.toHaveBeenCalled();
  });

  it("connect returns the public key and remembers it for isAuthorized", async () => {
    vi.mocked(lobstrGetPublicKey).mockResolvedValue(ADDRESS);
    await expect(lobstr.connect()).resolves.toBe(ADDRESS);
    expect(window.sessionStorage.getItem("meridian-lobstr-public-key")).toBe(
      ADDRESS
    );

    vi.mocked(lobstrIsConnected).mockResolvedValue(true);
    await expect(lobstr.isAuthorized()).resolves.toBe(true);
  });

  it("connect throws when getPublicKey returns an empty string", async () => {
    vi.mocked(lobstrGetPublicKey).mockResolvedValue("");
    await expect(lobstr.connect()).rejects.toThrow(
      "LOBSTR wallet returned no public key"
    );
  });

  it("sign returns the signed XDR on success", async () => {
    vi.mocked(lobstrSign).mockResolvedValue("SIGNED_XDR");
    await expect(lobstr.sign("XDR", "passphrase")).resolves.toBe("SIGNED_XDR");
  });

  it("sign passes only the XDR to the extension (no networkPassphrase)", async () => {
    vi.mocked(lobstrSign).mockResolvedValue("SIGNED_XDR");
    await lobstr.sign("XDR", "passphrase");
    expect(lobstrSign).toHaveBeenCalledWith("XDR");
    expect(lobstrSign).toHaveBeenCalledTimes(1);
  });

  it("sign throws when signing is cancelled (falsy return)", async () => {
    vi.mocked(lobstrSign).mockResolvedValue("");
    await expect(lobstr.sign("XDR", "passphrase")).rejects.toThrow(
      "Signing cancelled"
    );
  });

  it("sign propagates errors thrown by the extension", async () => {
    vi.mocked(lobstrSign).mockRejectedValue(new Error("User rejected"));
    await expect(lobstr.sign("XDR", "passphrase")).rejects.toThrow(
      "User rejected"
    );
  });
});

describe("LobstrWallet — e2e mock wallet path", () => {
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
    await expect(lobstr.isInstalled()).resolves.toBe(false);
    expect(lobstrIsConnected).not.toHaveBeenCalled();
  });

  it("short-circuits isInstalled true when mock says installed", async () => {
    setMockWallet({ installed: true });
    await expect(lobstr.isInstalled()).resolves.toBe(true);
    expect(lobstrIsConnected).not.toHaveBeenCalled();
  });

  it("short-circuits isAuthorized to installed && authorized", async () => {
    setMockWallet({ installed: true, authorized: false });
    await expect(lobstr.isAuthorized()).resolves.toBe(false);

    setMockWallet({ installed: false, authorized: true });
    await expect(lobstr.isAuthorized()).resolves.toBe(false);

    setMockWallet({ installed: true, authorized: true });
    await expect(lobstr.isAuthorized()).resolves.toBe(true);

    expect(lobstrGetPublicKey).not.toHaveBeenCalled();
    expect(lobstrIsConnected).not.toHaveBeenCalled();
  });

  it("short-circuits connect to the mock address", async () => {
    setMockWallet({ address: ADDRESS });
    await expect(lobstr.connect()).resolves.toBe(ADDRESS);
    expect(lobstrGetPublicKey).not.toHaveBeenCalled();
  });

  it("short-circuits sign to the mock sign function", async () => {
    const sign = vi.fn(async (xdr: string) => `SIGNED:${xdr}`);
    setMockWallet({ sign });
    await expect(lobstr.sign("XDR", "passphrase")).resolves.toBe("SIGNED:XDR");
    expect(sign).toHaveBeenCalledWith("XDR", "passphrase");
    expect(lobstrSign).not.toHaveBeenCalled();
  });

  it("propagates a decline rejection from the mock sign function", async () => {
    setMockWallet({
      sign: async () => {
        throw new Error("User declined access");
      },
    });
    await expect(lobstr.sign("XDR", "passphrase")).rejects.toThrow(
      "User declined access"
    );
  });
});
