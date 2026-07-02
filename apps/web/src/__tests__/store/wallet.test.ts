import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWalletStore } from "../../store/wallet";

vi.mock("../../lib/wallet", () => ({
  isFreighterInstalled: vi.fn(),
}));

import { isFreighterInstalled } from "../../lib/wallet";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => {
  useWalletStore.setState({
    publicKey: null,
    connected: false,
    network: "testnet",
  });
  vi.clearAllMocks();
});

describe("useWalletStore", () => {
  it("connect sets publicKey and marks connected", () => {
    useWalletStore.getState().connect(KEY);
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: KEY,
      connected: true,
    });
  });

  it("disconnect clears publicKey and marks disconnected", () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    useWalletStore.getState().disconnect();
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: null,
      connected: false,
    });
  });

  it("setNetwork updates the active network", () => {
    useWalletStore.getState().setNetwork("mainnet");
    expect(useWalletStore.getState().network).toBe("mainnet");
  });

  it("revalidate does nothing when no publicKey is set", async () => {
    await useWalletStore.getState().revalidate();
    expect(isFreighterInstalled).not.toHaveBeenCalled();
  });

  it("revalidate keeps connection when Freighter is still installed", async () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    vi.mocked(isFreighterInstalled).mockResolvedValue(true);
    await useWalletStore.getState().revalidate();
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: KEY,
      connected: true,
    });
  });

  it("revalidate disconnects when Freighter extension is gone", async () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    vi.mocked(isFreighterInstalled).mockResolvedValue(false);
    await useWalletStore.getState().revalidate();
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: null,
      connected: false,
    });
  });
});
