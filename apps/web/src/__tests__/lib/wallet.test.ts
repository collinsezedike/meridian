import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn(),
  isAllowed: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));

import {
  isConnected,
  isAllowed,
  requestAccess,
  signTransaction as freighterSign,
} from "@stellar/freighter-api";
import {
  isFreighterInstalled,
  isFreighterAuthorized,
  connectFreighter,
  signTransaction,
} from "../../lib/wallet";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

afterEach(() => {
  delete (window as unknown as { __E2E_MOCK_WALLET__?: unknown })
    .__E2E_MOCK_WALLET__;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lib/wallet — real Freighter path (no mock wallet present)", () => {
  it("isFreighterInstalled reflects the real isConnected result", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    await expect(isFreighterInstalled()).resolves.toBe(true);
  });

  it("isFreighterAuthorized is false when not installed", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: false });
    await expect(isFreighterAuthorized()).resolves.toBe(false);
    expect(isAllowed).not.toHaveBeenCalled();
  });

  it("isFreighterAuthorized reflects isAllowed when installed", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(isAllowed).mockResolvedValue({ isAllowed: true });
    await expect(isFreighterAuthorized()).resolves.toBe(true);
  });

  it("connectFreighter returns the address on success", async () => {
    vi.mocked(requestAccess).mockResolvedValue({ address: ADDRESS });
    await expect(connectFreighter()).resolves.toBe(ADDRESS);
  });

  it("connectFreighter throws the Freighter error message", async () => {
    vi.mocked(requestAccess).mockResolvedValue({
      address: "",
      error: { message: "User declined access", code: -4 },
    });
    await expect(connectFreighter()).rejects.toThrow("User declined access");
  });

  it("signTransaction returns the signed XDR on success", async () => {
    vi.mocked(freighterSign).mockResolvedValue({
      signedTxXdr: "SIGNED_XDR",
      signerAddress: ADDRESS,
    });
    await expect(signTransaction("XDR", "passphrase")).resolves.toBe(
      "SIGNED_XDR"
    );
  });

  it("signTransaction throws when signing is cancelled (no signedTxXdr)", async () => {
    vi.mocked(freighterSign).mockResolvedValue({
      signedTxXdr: "",
      signerAddress: "",
    });
    await expect(signTransaction("XDR", "passphrase")).rejects.toThrow(
      "Signing cancelled"
    );
  });
});

describe("lib/wallet — e2e mock wallet path", () => {
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

  it("short-circuits isFreighterInstalled without calling the real API", async () => {
    setMockWallet({ installed: false });
    await expect(isFreighterInstalled()).resolves.toBe(false);
    expect(isConnected).not.toHaveBeenCalled();
  });

  it("short-circuits isFreighterAuthorized on installed && authorized", async () => {
    setMockWallet({ installed: true, authorized: false });
    await expect(isFreighterAuthorized()).resolves.toBe(false);
    setMockWallet({ installed: true, authorized: true });
    await expect(isFreighterAuthorized()).resolves.toBe(true);
    expect(isAllowed).not.toHaveBeenCalled();
  });

  it("short-circuits connectFreighter to the mock address", async () => {
    setMockWallet({ address: ADDRESS });
    await expect(connectFreighter()).resolves.toBe(ADDRESS);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it("short-circuits signTransaction to the mock sign function", async () => {
    const sign = vi.fn(async (xdr: string) => `SIGNED:${xdr}`);
    setMockWallet({ sign });
    await expect(signTransaction("XDR", "passphrase")).resolves.toBe(
      "SIGNED:XDR"
    );
    expect(sign).toHaveBeenCalledWith("XDR", "passphrase");
    expect(freighterSign).not.toHaveBeenCalled();
  });

  it("propagates a decline rejection from the mock sign function", async () => {
    setMockWallet({
      sign: async () => {
        throw new Error("User declined access");
      },
    });
    await expect(signTransaction("XDR", "passphrase")).rejects.toThrow(
      "User declined access"
    );
  });
});
