import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVaultActions } from "../../hooks/useVaultActions";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";

const invalidateQueries = vi.fn();
const setQueryData = vi.fn();
const getQueryData = vi.fn(() => undefined);
vi.mock("@tanstack/react-query", async () => {
  const { useEffect, useRef, useState } = await import("react");

  function useQuery(options: {
    queryFn: () => Promise<unknown>;
    enabled?: boolean;
    refetchInterval?: (query: {
      state: { status: string; data: unknown };
    }) => number | false;
  }) {
    const [state, setState] = useState<{ status: string; data: unknown }>({
      status: "pending",
      data: undefined,
    });
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      if (!options.enabled) return;
      let cancelled = false;

      function scheduleNext(current: { status: string; data: unknown }) {
        const next = options.refetchInterval?.({ state: current });
        if (next === false || next === undefined) return;
        timerRef.current = setTimeout(tick, next);
      }

      async function tick() {
        try {
          const data = await options.queryFn();
          if (cancelled) return;
          const next = { status: "success", data };
          setState(next);
          scheduleNext(next);
        } catch {
          if (cancelled) return;
          const next = { status: "error", data: undefined };
          setState(next);
          scheduleNext(next);
        }
      }

      void tick();
      return () => {
        cancelled = true;
        if (timerRef.current) clearTimeout(timerRef.current);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [options.enabled]);

    return state;
  }

  return {
    useQueryClient: () => ({ invalidateQueries, setQueryData, getQueryData }),
    useQuery,
  };
});

vi.mock("../../lib/wallet", () => ({
  wallet: {
    sign: vi.fn(async () => "SIGNED_XDR"),
    isAuthorized: vi.fn(async () => true),
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    addTrustline: vi.fn(async () => ({ xdr: "TRUSTLINE_XDR" })),
    buildDeposit: vi.fn(async () => ({ xdr: "DEPOSIT_XDR" })),
    buildWithdraw: vi.fn(async () => ({ xdr: "WITHDRAW_XDR" })),
    submitTx: vi.fn(async () => ({ hash: "TX_HASH" })),
    getPositions: vi.fn(async () => ({ positions: [] })),
  },
}));

vi.mock("react-i18next", () => {
  const translations: Record<string, string> = {
    "vaultActions.deposited": "Deposited",
    "vaultActions.withdrew": "Withdrew",
    "vaultActions.depositFailed": "Deposit failed",
    "vaultActions.withdrawalFailed": "Withdrawal failed",
  };

  return {
    useTranslation: () => ({
      t: (key: string) => translations[key] ?? key,
    }),
  };
});

import { api } from "../../lib/api";
import { wallet } from "../../lib/wallet";
import { USDC_ISSUER, MUSDC_ISSUER } from "@meridian/shared";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// Pulled from the source of truth rather than hardcoded, so these fixtures
// don't drift out of sync the next time the vault (and its mUSDC issuer) is
// redeployed, as happened with the previous hardcoded value in #514.
const BLEND_TESTNET_USDC_ISSUER = USDC_ISSUER.testnet;
const MUSDC_TESTNET_ISSUER = MUSDC_ISSUER.testnet;

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

beforeEach(() => {
  useWalletStore.setState({
    publicKey: KEY,
    connected: true,
    network: "testnet",
  });
  useToastStore.setState({ toasts: [] });
  invalidateQueries.mockClear();
  setQueryData.mockClear();
  getQueryData.mockClear();
  vi.clearAllMocks();
  // Stub fetch so both the proactive trustline check and hasBlendUsdcBalance
  // see USDC + mUSDC trustlines and a positive USDC balance, skipping the
  // add-trustline and testnet-faucet paths (those are covered in
  // useTrustlines.test.ts and useBlendFaucet.test.ts).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => bothTrustlinesHorizonResponse())
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVaultActions — deposit", () => {
  it("builds, signs, and submits a deposit successfully", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit("10", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(true);
    expect(api.buildDeposit).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      min_shares_out: undefined,
    });
    expect(wallet.sign).toHaveBeenCalledWith(
      "DEPOSIT_XDR",
      expect.stringContaining("Test SDF")
    );
    expect(api.submitTx).toHaveBeenCalledWith({ xdr: "SIGNED_XDR" });
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "success",
      message: "Deposited 10 USDC",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["vaults"] });
  });

  it("passes minSharesOut when specified", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit(
        "10",
        "blend-usdc-fixed",
        "USDC",
        "9.5"
      );
    });

    expect(ok).toBe(true);
    expect(api.buildDeposit).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      min_shares_out: "9.5",
    });
  });

  it("returns false without calling the API when no publicKey", async () => {
    useWalletStore.setState({
      publicKey: null,
      connected: false,
      network: "testnet",
    });
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit("10", "v", "USDC");
    });

    expect(ok).toBe(false);
    expect(api.buildDeposit).not.toHaveBeenCalled();
  });
});

describe("useVaultActions — withdraw", () => {
  it("builds, signs, and submits a withdrawal successfully", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.withdraw("5", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(true);
    expect(api.buildWithdraw).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
      min_usdc_out: undefined,
    });
    expect(wallet.sign).toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "success",
      message: "Withdrew 5 USDC",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["vaults"] });
  });

  it("passes minUsdcOut when specified", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.withdraw(
        "5",
        "blend-usdc-fixed",
        "USDC",
        "4.8"
      );
    });

    expect(ok).toBe(true);
    expect(api.buildWithdraw).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
      min_usdc_out: "4.8",
    });
  });

  it("pushes an error toast and returns false when withdraw fails", async () => {
    vi.mocked(api.buildWithdraw).mockRejectedValueOnce(
      new Error("Insufficient shares")
    );
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.withdraw("5", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(false);
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "error" });
  });
});
