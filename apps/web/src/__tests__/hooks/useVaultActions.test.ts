import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
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
  signTransaction: vi.fn(async () => "SIGNED_XDR"),
  isFreighterAuthorized: vi.fn(async () => true),
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
    "vaultActions.assetsAdded": "Vault assets added to wallet",
    "vaultActions.depositFailed": "Deposit failed",
    "vaultActions.withdrawalFailed": "Withdrawal failed",
    "vaultActions.failedAssets": "Failed to add vault assets",
    "vaultActions.syncDelayed": "Updating your balance...",
  };

  return {
    useTranslation: () => ({
      t: (key: string) => translations[key] ?? key,
    }),
  };
});

import { api } from "../../lib/api";
import { signTransaction } from "../../lib/wallet";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// Matches USDC_ISSUER.testnet / MUSDC_ISSUER.testnet in @meridian/shared.
const BLEND_TESTNET_USDC_ISSUER =
  "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
const MUSDC_TESTNET_ISSUER =
  "GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

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

function zeroBalanceHorizonResponse() {
  return new Response(JSON.stringify({ balances: [] }), { status: 200 });
}

function faucetTextResponse(op: ReturnType<typeof Operation.payment>) {
  const account = new Account(KEY, "0");
  const xdr = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
  return new Response(xdr, { status: 200 });
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
  // add-trustline and testnet-faucet paths. Tests that need either path
  // override this per-test.
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
    });
    expect(signTransaction).toHaveBeenCalledWith(
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

  it("silently establishes a missing mUSDC trustline before depositing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // Trustline check: mUSDC trustline missing.
        .mockResolvedValueOnce(
          new Response(
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
          )
        )
        // hasBlendUsdcBalance check, called after the trustline is established.
        .mockResolvedValueOnce(bothTrustlinesHorizonResponse())
    );
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit("10", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(true);
    expect(api.addTrustline).toHaveBeenCalledWith(KEY);
    expect(api.buildDeposit).toHaveBeenCalled();
    // Once to sign the trustline transaction, once for the deposit itself.
    expect(signTransaction).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        kind: "success",
        message: "Vault assets added to wallet",
      })
    );
  });

  it("does not attempt a trustline transaction when both already exist", async () => {
    const { result } = renderHook(() => useVaultActions());

    await act(async () => {
      await result.current.deposit("10", "blend-usdc-fixed", "USDC");
    });

    expect(api.addTrustline).not.toHaveBeenCalled();
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

  it("signs a faucet transaction that credits the caller's own address", async () => {
    const legitimate = faucetTextResponse(
      Operation.payment({
        destination: KEY,
        asset: new Asset("USDC", BLEND_TESTNET_USDC_ISSUER),
        amount: "1000",
      })
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // Trustline check: both already present.
        .mockResolvedValueOnce(bothTrustlinesHorizonResponse())
        // hasBlendUsdcBalance check: no USDC balance yet.
        .mockResolvedValueOnce(zeroBalanceHorizonResponse())
        .mockResolvedValueOnce(legitimate)
    );
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit("10", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(true);
    // Once to sign the faucet grant, once to sign the deposit itself.
    expect(signTransaction).toHaveBeenCalledTimes(2);
    expect(api.buildDeposit).toHaveBeenCalled();
  });

  it("rejects a faucet transaction that pays out to someone else", async () => {
    const attacker = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
    const malicious = faucetTextResponse(
      Operation.payment({
        destination: attacker,
        asset: new Asset("USDC", BLEND_TESTNET_USDC_ISSUER),
        amount: "1000",
      })
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(bothTrustlinesHorizonResponse())
        .mockResolvedValueOnce(zeroBalanceHorizonResponse())
        .mockResolvedValueOnce(malicious)
    );
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit("10", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(false);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(api.buildDeposit).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({ kind: "error" })
    );
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
    });
    expect(signTransaction).toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "success",
      message: "Withdrew 5 USDC",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["vaults"] });
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

  it("logs and surfaces a toast after repeated post-withdraw sync failures", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(api.getPositions).mockRejectedValue(new Error("RPC down"));

    const { result } = renderHook(() => useVaultActions());

    await act(async () => {
      await result.current.withdraw("5", "blend-usdc-fixed", "USDC");
    });

    // Initial 3s delay before polling starts, then 3 failed attempts at 3s intervals.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
    }

    expect(warnSpy).toHaveBeenCalledWith("[positions poll] failed, attempt", 3);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        kind: "info",
        message: "Updating your balance...",
      })
    );

    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("stops polling when the component unmounts mid-poll", async () => {
    vi.useFakeTimers();
    vi.mocked(api.getPositions).mockRejectedValue(new Error("RPC down"));

    const { result, unmount } = renderHook(() => useVaultActions());

    await act(async () => {
      await result.current.withdraw("5", "blend-usdc-fixed", "USDC");
    });

    // Let polling start (3s delay) and complete one attempt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const callsBeforeUnmount = vi.mocked(api.getPositions).mock.calls.length;

    unmount();

    // Advance well past several more would-be poll intervals.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(vi.mocked(api.getPositions).mock.calls.length).toBe(
      callsBeforeUnmount
    );

    vi.useRealTimers();
  });

  it("does not activate polling if unmounted before the 3s activation delay", async () => {
    vi.useFakeTimers();
    vi.mocked(api.getPositions).mockResolvedValue({ positions: [] });

    const { result, unmount } = renderHook(() => useVaultActions());

    await act(async () => {
      await result.current.withdraw("5", "blend-usdc-fixed", "USDC");
    });

    // Still inside the 3s activation window — polling has not started yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(api.getPositions).not.toHaveBeenCalled();

    // Unmount before the activation timeout fires. The pending timeout
    // should be cancelled by the hook's cleanup effect rather than firing
    // setIsPollingPositions on a hook instance whose owning component is
    // already gone.
    unmount();

    // Advance well past the original 3s mark and beyond.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // Polling never activated, so getPositions should never have been called.
    expect(api.getPositions).not.toHaveBeenCalled();
  });
});
