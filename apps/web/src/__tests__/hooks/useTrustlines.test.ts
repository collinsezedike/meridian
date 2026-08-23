import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useTrustlines,
  hasRequiredTrustlines,
} from "../../hooks/useTrustlines";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";
import { USDC_ISSUER, MUSDC_ISSUER } from "@meridian/shared";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// Pulled from the source of truth rather than hardcoded, so these fixtures
// don't drift out of sync the next time the vault (and its mUSDC issuer) is
// redeployed, as happened with the previous hardcoded value in #514.
const BLEND_TESTNET_USDC_ISSUER = USDC_ISSUER.testnet;
const MUSDC_TESTNET_ISSUER = MUSDC_ISSUER.testnet;

vi.mock("../../lib/wallet", () => ({
  wallet: {
    sign: vi.fn(async () => "SIGNED_XDR"),
    isAuthorized: vi.fn(async () => true),
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    addTrustline: vi.fn(async () => ({ xdr: "TRUSTLINE_XDR" })),
    submitTx: vi.fn(async () => ({ hash: "TX_HASH" })),
  },
}));

vi.mock("react-i18next", () => {
  const translations: Record<string, string> = {
    "vaultActions.assetsAdded": "Vault assets added to wallet",
    "vaultActions.failedAssets": "Failed to add vault assets",
  };
  return {
    useTranslation: () => ({
      t: (key: string) => translations[key] ?? key,
    }),
  };
});

import { api } from "../../lib/api";
import { wallet } from "../../lib/wallet";

function bothTrustlinesHorizonResponse() {
  return new Response(
    JSON.stringify({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: BLEND_TESTNET_USDC_ISSUER,
          balance: "100.0000000",
        },
        {
          asset_type: "credit_alphanum4",
          asset_code: "MUSDC",
          asset_issuer: MUSDC_TESTNET_ISSUER,
          balance: "0.0000000",
        },
      ],
    }),
    { status: 200 }
  );
}

function missingMusdcTrustlineHorizonResponse() {
  return new Response(
    JSON.stringify({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: BLEND_TESTNET_USDC_ISSUER,
          balance: "100.0000000",
        },
      ],
    }),
    { status: 200 }
  );
}

beforeEach(() => {
  useWalletStore.setState({
    publicKey: KEY,
    connected: true,
    network: "testnet",
  });
  useToastStore.setState({ toasts: [] });
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => bothTrustlinesHorizonResponse())
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTrustlines", () => {
  it("reports both trustlines present when both already exist", async () => {
    const result = await hasRequiredTrustlines(KEY, "testnet");
    expect(result).toBe(true);
  });

  it("reports trustlines missing when mUSDC is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => missingMusdcTrustlineHorizonResponse())
    );
    const result = await hasRequiredTrustlines(KEY, "testnet");
    expect(result).toBe(false);
  });

  it("establishes a missing trustline via addTrustline", async () => {
    const { result } = renderHook(() => useTrustlines());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addTrustline();
    });

    expect(ok).toBe(true);
    expect(api.addTrustline).toHaveBeenCalledWith(KEY);
    expect(wallet.sign).toHaveBeenCalledWith(
      "TRUSTLINE_XDR",
      expect.stringContaining("Test SDF")
    );
    expect(api.submitTx).toHaveBeenCalledWith({ xdr: "SIGNED_XDR" });
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        kind: "success",
        message: "Vault assets added to wallet",
      })
    );
  });
});
