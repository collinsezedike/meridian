import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@albedo-link/intent", () => ({
  default: {
    publicKey: vi.fn(),
    tx: vi.fn(),
  },
}));

import albedo from "@albedo-link/intent";
import { AlbedoWallet } from "../../lib/wallet";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// Create a fresh instance per-file so we don't share state with the singleton
// `wallet` export (which is FreighterWallet).
const albedoWallet = new AlbedoWallet();

afterEach(() => {
  delete (window as unknown as { __E2E_MOCK_WALLET__?: unknown })
    .__E2E_MOCK_WALLET__;
});

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("AlbedoWallet — real Albedo path (no mock wallet present)", () => {
  it("isInstalled always returns true (Albedo is web-based, no extension)", async () => {
    await expect(albedoWallet.isInstalled()).resolves.toBe(true);
    // No Albedo API call should be made for an install check
    expect(vi.mocked(albedo.publicKey)).not.toHaveBeenCalled();
    expect(vi.mocked(albedo.tx)).not.toHaveBeenCalled();
  });

  // Albedo has no passive permission query without opening the popup.
  // isAuthorized must not call publicKey() (which opens the popup) — it
  // checks sessionStorage for a key stored by a prior connect().
  it("isAuthorized returns true when a key was stored by connect", async () => {
    window.sessionStorage.setItem("meridian-albedo-public-key", ADDRESS);
    await expect(albedoWallet.isAuthorized()).resolves.toBe(true);
    expect(vi.mocked(albedo.publicKey)).not.toHaveBeenCalled();
  });

  it("isAuthorized returns false when nothing was stored", async () => {
    await expect(albedoWallet.isAuthorized()).resolves.toBe(false);
    expect(vi.mocked(albedo.publicKey)).not.toHaveBeenCalled();
  });

  it("isAuthorized never calls publicKey (passive, no prompt)", async () => {
    await albedoWallet.isAuthorized();
    expect(vi.mocked(albedo.publicKey)).not.toHaveBeenCalled();
  });

  it("connect returns the public key and remembers it for isAuthorized", async () => {
    vi.mocked(albedo.publicKey).mockResolvedValue({
      pubkey: ADDRESS,
      signed_message: "msg",
      signature: "sig",
    });
    await expect(albedoWallet.connect()).resolves.toBe(ADDRESS);
    expect(window.sessionStorage.getItem("meridian-albedo-public-key")).toBe(
      ADDRESS
    );

    await expect(albedoWallet.isAuthorized()).resolves.toBe(true);
  });

  it("connect throws when publicKey returns no pubkey", async () => {
    vi.mocked(albedo.publicKey).mockResolvedValue({
      pubkey: "",
      signed_message: "",
      signature: "",
    });
    await expect(albedoWallet.connect()).rejects.toThrow(
      "Albedo wallet returned no public key"
    );
  });

  it("connect throws a cancel-worded error when the user closes the popup", async () => {
    // Closing the Albedo popup does not reject the request: transportCloseHandler()
    // resolves it with intentErrors.actionRejectedByUser ({message, code: -4}, no
    // .error field). This must surface as a cancel, matching useWalletConnect.ts's
    // /cancel|decline|reject/i filter, not the generic "no public key" error.
    // @albedo-link/intent's own PublicKeyIntentResult type doesn't model this
    // shape at all, even though it's what the library actually resolves with
    // on cancellation, hence the cast.
    vi.mocked(albedo.publicKey).mockResolvedValue({
      message: "Action request was rejected by the user.",
      code: -4,
    } as unknown as Awaited<ReturnType<typeof albedo.publicKey>>);
    await expect(albedoWallet.connect()).rejects.toThrow(
      "Connection cancelled"
    );
  });

  it("connect propagates errors thrown by Albedo", async () => {
    vi.mocked(albedo.publicKey).mockRejectedValue(new Error("User rejected"));
    await expect(albedoWallet.connect()).rejects.toThrow("User rejected");
  });

  it("connect calls publicKey with an empty object (token auto-generated)", async () => {
    vi.mocked(albedo.publicKey).mockResolvedValue({
      pubkey: ADDRESS,
      signed_message: "msg",
      signature: "sig",
    });
    await albedoWallet.connect();
    expect(albedo.publicKey).toHaveBeenCalledWith({});
  });

  it("sign returns the signed envelope on success", async () => {
    vi.mocked(albedo.tx).mockResolvedValue({
      signed_envelope_xdr: "SIGNED_XDR",
      xdr: "XDR",
      tx_hash: "hash",
      network: "testnet",
      result: {},
    });
    await expect(albedoWallet.sign("XDR", "passphrase")).resolves.toBe(
      "SIGNED_XDR"
    );
  });

  it("sign forwards XDR, mapped network, and submit:false to Albedo", async () => {
    vi.mocked(albedo.tx).mockResolvedValue({
      signed_envelope_xdr: "SIGNED_XDR",
      xdr: "XDR",
      tx_hash: "hash",
      network: "testnet",
      result: {},
    });
    await albedoWallet.sign("XDR", "Test SDF Network ; September 2015");
    expect(albedo.tx).toHaveBeenCalledWith({
      xdr: "XDR",
      network: "testnet",
      submit: false,
    });
  });

  it("sign maps mainnet passphrase to public", async () => {
    vi.mocked(albedo.tx).mockResolvedValue({
      signed_envelope_xdr: "SIGNED_XDR",
      xdr: "XDR",
      tx_hash: "hash",
      network: "public",
      result: {},
    });
    await albedoWallet.sign(
      "XDR",
      "Public Global Stellar Network ; September 2015"
    );
    expect(albedo.tx).toHaveBeenCalledWith({
      xdr: "XDR",
      network: "public",
      submit: false,
    });
  });

  it("sign passes through unknown network strings unchanged", async () => {
    vi.mocked(albedo.tx).mockResolvedValue({
      signed_envelope_xdr: "SIGNED_XDR",
      xdr: "XDR",
      tx_hash: "hash",
      network: "passphrase",
      result: {},
    });
    await albedoWallet.sign("XDR", "passphrase");
    expect(albedo.tx).toHaveBeenCalledWith({
      xdr: "XDR",
      network: "passphrase",
      submit: false,
    });
  });

  it("sign throws when signing is cancelled (no signed_envelope_xdr)", async () => {
    vi.mocked(albedo.tx).mockResolvedValue({
      signed_envelope_xdr: "",
      xdr: "XDR",
      tx_hash: "",
      network: "testnet",
      result: {},
    });
    await expect(albedoWallet.sign("XDR", "passphrase")).rejects.toThrow(
      "Signing cancelled"
    );
  });

  it("sign propagates errors thrown by Albedo", async () => {
    vi.mocked(albedo.tx).mockRejectedValue(new Error("User rejected"));
    await expect(albedoWallet.sign("XDR", "passphrase")).rejects.toThrow(
      "User rejected"
    );
  });
});

describe("AlbedoWallet — e2e mock wallet path", () => {
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
    await expect(albedoWallet.isInstalled()).resolves.toBe(false);
    expect(albedo.publicKey).not.toHaveBeenCalled();
    expect(albedo.tx).not.toHaveBeenCalled();
  });

  it("short-circuits isInstalled true when mock says installed", async () => {
    setMockWallet({ installed: true });
    await expect(albedoWallet.isInstalled()).resolves.toBe(true);
    expect(albedo.publicKey).not.toHaveBeenCalled();
  });

  it("short-circuits isAuthorized to installed && authorized", async () => {
    setMockWallet({ installed: true, authorized: false });
    await expect(albedoWallet.isAuthorized()).resolves.toBe(false);

    setMockWallet({ installed: false, authorized: true });
    await expect(albedoWallet.isAuthorized()).resolves.toBe(false);

    setMockWallet({ installed: true, authorized: true });
    await expect(albedoWallet.isAuthorized()).resolves.toBe(true);

    expect(albedo.publicKey).not.toHaveBeenCalled();
  });

  it("short-circuits connect to the mock address", async () => {
    setMockWallet({ address: ADDRESS });
    await expect(albedoWallet.connect()).resolves.toBe(ADDRESS);
    expect(albedo.publicKey).not.toHaveBeenCalled();
  });

  it("short-circuits sign to the mock sign function", async () => {
    const sign = vi.fn(async (xdr: string) => `SIGNED:${xdr}`);
    setMockWallet({ sign });
    await expect(albedoWallet.sign("XDR", "passphrase")).resolves.toBe(
      "SIGNED:XDR"
    );
    expect(sign).toHaveBeenCalledWith("XDR", "passphrase");
    expect(albedo.tx).not.toHaveBeenCalled();
  });

  it("propagates a decline rejection from the mock sign function", async () => {
    setMockWallet({
      sign: async () => {
        throw new Error("User declined access");
      },
    });
    await expect(albedoWallet.sign("XDR", "passphrase")).rejects.toThrow(
      "User declined access"
    );
  });
});
