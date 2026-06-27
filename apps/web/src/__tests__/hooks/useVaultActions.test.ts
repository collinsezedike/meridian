import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVaultActions } from "../../hooks/useVaultActions";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";

const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("../../lib/wallet", () => ({
  signTransaction: vi.fn(async () => "SIGNED_XDR"),
}));

vi.mock("../../lib/api", () => ({
  api: {
    addTrustline: vi.fn(async () => ({ xdr: "TRUSTLINE_XDR" })),
    buildDeposit: vi.fn(async () => ({ xdr: "DEPOSIT_XDR" })),
    buildWithdraw: vi.fn(async () => ({ xdr: "WITHDRAW_XDR" })),
    submitTx: vi.fn(async () => ({ hash: "TX_HASH" })),
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

beforeEach(() => {
  useWalletStore.setState({ publicKey: KEY, connected: true, network: "testnet" });
  useToastStore.setState({ toasts: [] });
  invalidateQueries.mockClear();
  vi.clearAllMocks();
});

describe("useVaultActions — deposit", () => {
  it("builds, signs, and submits a deposit successfully", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.deposit("10", "blend-usdc-fixed", "USDC"); });

    expect(ok).toBe(true);
    expect(api.buildDeposit).toHaveBeenCalledWith({ walletAddress: KEY, vaultId: "blend-usdc-fixed", amount: "10" });
    expect(signTransaction).toHaveBeenCalledWith("DEPOSIT_XDR", expect.stringContaining("Test SDF"));
    expect(api.submitTx).toHaveBeenCalledWith({ xdr: "SIGNED_XDR" });
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "success", message: "Deposited 10 USDC" });
  });

  it("sets needsTrustline when the API signals a missing trustline", async () => {
    vi.mocked(api.buildDeposit).mockRejectedValueOnce(new Error("USDC trustline missing"));
    const { result } = renderHook(() => useVaultActions());

    await act(async () => { await result.current.deposit("10", "blend-usdc-fixed", "USDC"); });

    expect(result.current.needsTrustline).toBe(true);
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "error" });
  });

  it("returns false without calling the API when no publicKey", async () => {
    useWalletStore.setState({ publicKey: null, connected: false, network: "testnet" });
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.deposit("10", "v", "USDC"); });

    expect(ok).toBe(false);
    expect(api.buildDeposit).not.toHaveBeenCalled();
  });
});

describe("useVaultActions — withdraw", () => {
  it("builds, signs, and submits a withdrawal successfully", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.withdraw("5", "blend-usdc-fixed", "USDC"); });

    expect(ok).toBe(true);
    expect(api.buildWithdraw).toHaveBeenCalledWith({ walletAddress: KEY, vaultId: "blend-usdc-fixed", shares: "5" });
    expect(signTransaction).toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "success", message: "Withdrew 5 USDC" });
  });

  it("pushes an error toast and returns false when withdraw fails", async () => {
    vi.mocked(api.buildWithdraw).mockRejectedValueOnce(new Error("Insufficient shares"));
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.withdraw("5", "blend-usdc-fixed", "USDC"); });

    expect(ok).toBe(false);
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "error" });
  });
});
