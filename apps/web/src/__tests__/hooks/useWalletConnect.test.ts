import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";

vi.mock("../../lib/wallet", () => ({
  isFreighterInstalled: vi.fn(),
  connectFreighter: vi.fn(),
}));

vi.mock("react-i18next", () => {
  const translations: Record<string, string> = {
    "walletConnect.disconnect": "Disconnect",
    "walletConnect.copyAddress": "Copy Address",
    "walletConnect.copied": "Copied",
    "common.installFreighter": "Install Freighter",
    "common.connectWallet": "Connect Wallet",
    "common.connecting": "Connecting...",
    "walletConnect.walletDisconnected": "Wallet Disconnected",
    "walletConnect.walletConnected" : "Wallet Connected",
  };

  return {
    useTranslation: () => ({
      t: (key: string) => translations[key] ?? key,
    }),
  };
});

import { isFreighterInstalled, connectFreighter } from "../../lib/wallet";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => {
  useWalletStore.setState({ publicKey: null, connected: false, network: "testnet" });
  useToastStore.setState({ toasts: [] });
  vi.clearAllMocks();
});

describe("useWalletConnect", () => {
  it("sets status to no-extension when Freighter is not installed", async () => {
    vi.mocked(isFreighterInstalled).mockResolvedValue(false);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("no-extension");
    expect(useWalletStore.getState().connected).toBe(false);
  });

  it("connects and resets to idle on success", async () => {
    vi.mocked(isFreighterInstalled).mockResolvedValue(true);
    vi.mocked(connectFreighter).mockResolvedValue(KEY);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("idle");
    expect(useWalletStore.getState()).toMatchObject({ publicKey: KEY, connected: true });
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "success" });
  });

  it("swallows user-cancel errors without a toast", async () => {
    vi.mocked(isFreighterInstalled).mockResolvedValue(true);
    vi.mocked(connectFreighter).mockRejectedValue(new Error("User declined request"));
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("idle");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("shows an error toast for unexpected connect failures", async () => {
    vi.mocked(isFreighterInstalled).mockResolvedValue(true);
    vi.mocked(connectFreighter).mockRejectedValue(new Error("Network error"));
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("idle");
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "error", message: "Network error" });
  });
});
