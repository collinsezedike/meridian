import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn(),
  isAllowed: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("@lobstrco/signer-extension-api", () => ({
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  signTransaction: vi.fn(),
}));

import {
  isConnected,
  isAllowed,
  requestAccess,
  signTransaction as freighterSign,
} from "@stellar/freighter-api";
import { isConnected as lobstrIsConnected } from "@lobstrco/signer-extension-api";
import {
  wallet,
  WALLETS,
  isWalletId,
  getSelectedWalletId,
  setSelectedWalletId,
  getWalletMeta,
  getWalletAdapter,
} from "../../lib/wallet";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SELECTED_WALLET_STORAGE_KEY = "meridian-selected-wallet";

afterEach(() => {
  delete (window as unknown as { __E2E_MOCK_WALLET__?: unknown })
    .__E2E_MOCK_WALLET__;
  window.localStorage.removeItem(SELECTED_WALLET_STORAGE_KEY);
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem(SELECTED_WALLET_STORAGE_KEY);
});

describe("wallet registry", () => {
  it("lists Freighter, LOBSTR, and xBull as picker-wired adapters", () => {
    // AlbedoWallet is implemented and tested (see albedo-wallet.test.ts) but
    // deliberately not wired into WALLETS yet: wallet-picker UI exposure is
    // out of scope for the PR that added it (#674), gated on #611.
    expect(WALLETS.map((w) => w.id)).toEqual(["freighter", "lobstr", "xbull"]);
  });

  it("isWalletId accepts only picker-wired ids", () => {
    expect(isWalletId("freighter")).toBe(true);
    expect(isWalletId("lobstr")).toBe(true);
    expect(isWalletId("xbull")).toBe(true);
    expect(isWalletId("albedo")).toBe(false);
    expect(isWalletId(null)).toBe(false);
  });

  it("defaults the selected wallet to Freighter when nothing is stored", () => {
    expect(getSelectedWalletId()).toBe("freighter");
  });

  it("falls back to Freighter for a corrupt or unrecognized stored value", () => {
    window.localStorage.setItem(SELECTED_WALLET_STORAGE_KEY, "not-a-wallet");
    expect(getSelectedWalletId()).toBe("freighter");
  });

  it("persists an explicit selection across reads", () => {
    setSelectedWalletId("lobstr");
    expect(getSelectedWalletId()).toBe("lobstr");
    expect(window.localStorage.getItem(SELECTED_WALLET_STORAGE_KEY)).toBe(
      "lobstr"
    );
  });

  it("getWalletMeta/getWalletAdapter resolve the matching registry entry", () => {
    expect(getWalletMeta("lobstr").name).toBe("LOBSTR");
    expect(getWalletAdapter("lobstr")).toBe(
      WALLETS.find((w) => w.id === "lobstr")!.adapter
    );
  });

  it("the wallet dispatcher follows the persisted selection, not a fixed adapter", async () => {
    setSelectedWalletId("lobstr");
    vi.mocked(lobstrIsConnected).mockResolvedValue(true);
    await expect(wallet.isInstalled()).resolves.toBe(true);
    // If the dispatcher were pinned to Freighter, this would call the real
    // Freighter isConnected() instead of LOBSTR's isConnected().
    expect(isConnected).not.toHaveBeenCalled();
    expect(lobstrIsConnected).toHaveBeenCalledOnce();
  });
});

describe("wallet — real Freighter path (no mock wallet present)", () => {
  it("isInstalled reflects the real isConnected result", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    await expect(wallet.isInstalled()).resolves.toBe(true);
  });

  it("isAuthorized is false when not installed", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: false });
    await expect(wallet.isAuthorized()).resolves.toBe(false);
    expect(isAllowed).not.toHaveBeenCalled();
  });

  it("isAuthorized reflects isAllowed when installed", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(isAllowed).mockResolvedValue({ isAllowed: true });
    await expect(wallet.isAuthorized()).resolves.toBe(true);
  });

  it("connect returns the address on success", async () => {
    vi.mocked(requestAccess).mockResolvedValue({ address: ADDRESS });
    await expect(wallet.connect()).resolves.toBe(ADDRESS);
  });

  it("connect throws the Freighter error message", async () => {
    vi.mocked(requestAccess).mockResolvedValue({
      address: "",
      error: { message: "User declined access", code: -4 },
    });
    await expect(wallet.connect()).rejects.toThrow("User declined access");
  });

  it("sign returns the signed XDR on success", async () => {
    vi.mocked(freighterSign).mockResolvedValue({
      signedTxXdr: "SIGNED_XDR",
      signerAddress: ADDRESS,
    });
    await expect(wallet.sign("XDR", "passphrase")).resolves.toBe("SIGNED_XDR");
  });

  it("sign throws when signing is cancelled (no signedTxXdr)", async () => {
    vi.mocked(freighterSign).mockResolvedValue({
      signedTxXdr: "",
      signerAddress: "",
    });
    await expect(wallet.sign("XDR", "passphrase")).rejects.toThrow(
      "Signing cancelled"
    );
  });
});

describe("wallet — e2e mock wallet path", () => {
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
    await expect(wallet.isInstalled()).resolves.toBe(false);
    expect(isConnected).not.toHaveBeenCalled();
  });

  it("short-circuits isAuthorized on installed && authorized", async () => {
    setMockWallet({ installed: true, authorized: false });
    await expect(wallet.isAuthorized()).resolves.toBe(false);
    setMockWallet({ installed: true, authorized: true });
    await expect(wallet.isAuthorized()).resolves.toBe(true);
    expect(isAllowed).not.toHaveBeenCalled();
  });

  it("short-circuits connect to the mock address", async () => {
    setMockWallet({ address: ADDRESS });
    await expect(wallet.connect()).resolves.toBe(ADDRESS);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it("short-circuits sign to the mock sign function", async () => {
    const sign = vi.fn(async (xdr: string) => `SIGNED:${xdr}`);
    setMockWallet({ sign });
    await expect(wallet.sign("XDR", "passphrase")).resolves.toBe("SIGNED:XDR");
    expect(sign).toHaveBeenCalledWith("XDR", "passphrase");
    expect(freighterSign).not.toHaveBeenCalled();
  });

  it("propagates a decline rejection from the mock sign function", async () => {
    setMockWallet({
      sign: async () => {
        throw new Error("User declined access");
      },
    });
    await expect(wallet.sign("XDR", "passphrase")).rejects.toThrow(
      "User declined access"
    );
  });
});
