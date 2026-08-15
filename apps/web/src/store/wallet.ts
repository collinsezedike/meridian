import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WalletState } from "../types";
import { wallet } from "../lib/wallet";

interface WalletStore extends WalletState {
  connect: (publicKey: string) => void;
  disconnect: () => void;
  setNetwork: (network: WalletState["network"]) => void;
  revalidate: () => Promise<void>;
}

export const useWalletStore = create<WalletStore>()(
  persist(
    (set, get) => ({
      publicKey: null,
      network: "testnet",
      connected: false,

      connect: (publicKey) => set({ publicKey, connected: true }),
      disconnect: () => set({ publicKey: null, connected: false }),
      setNetwork: (network) => set({ network }),

      // Re-check the persisted key against Freighter. Clears stale state when
      // the extension is gone or the user revoked site access between sessions.
      revalidate: async () => {
        if (!get().publicKey) return;
        const authorized = await wallet.isAuthorized();
        if (!authorized) set({ publicKey: null, connected: false });
      },
    }),
    {
      name: "meridian-wallet",
      partialize: (s) => ({ publicKey: s.publicKey, network: s.network }),
      // `connected` is never persisted — re-derive it from the restored key.
      onRehydrateStorage: () => (state) => {
        if (state) state.connected = state.publicKey != null;
      },
    }
  )
);
