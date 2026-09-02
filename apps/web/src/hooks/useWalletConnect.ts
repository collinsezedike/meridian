import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import {
  getSelectedWalletId,
  getWalletAdapter,
  setSelectedWalletId,
  type WalletId,
} from "../lib/wallet";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

export type ConnectStatus = "idle" | "connecting" | "no-extension";

export function useWalletConnect() {
  const { t } = useTranslation();
  const { connect } = useWalletStore();
  const { push } = useToastStore();
  const [status, setStatus] = useState<ConnectStatus>("idle");
  // The wallet handleConnect most recently attempted — meaningful once
  // status is "connecting" or "no-extension", so the UI knows which
  // wallet's install link to show. Defaults to the persisted selection so a
  // returning user's plain "Connect Wallet" click (no explicit walletId)
  // still resolves to the right wallet from the very first render.
  const [attemptedWalletId, setAttemptedWalletId] =
    useState<WalletId>(getSelectedWalletId);

  async function handleConnect(walletId: WalletId = getSelectedWalletId()) {
    setAttemptedWalletId(walletId);
    const adapter = getWalletAdapter(walletId);
    const installed = await adapter.isInstalled();
    if (!installed) {
      setStatus("no-extension");
      return;
    }

    setStatus("connecting");
    try {
      const key = await adapter.connect();
      // Only persisted on success: a failed or cancelled connect attempt
      // must not silently switch which wallet future sign/reconnect calls
      // (which dispatch off the persisted selection) go through.
      setSelectedWalletId(walletId);
      connect(key);
      setStatus("idle");
      push("success", t("walletConnect.walletConnected"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // User closed the popup — not an error worth surfacing
      if (!message || /cancel|decline|reject/i.test(message)) {
        setStatus("idle");
        return;
      }
      push("error", message);
      setStatus("idle");
    }
  }

  return { handleConnect, status, attemptedWalletId };
}
