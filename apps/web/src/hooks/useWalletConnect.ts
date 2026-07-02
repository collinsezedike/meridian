import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import { isFreighterInstalled, connectFreighter } from "../lib/wallet";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

export type ConnectStatus = "idle" | "connecting" | "no-extension";

export function useWalletConnect() {
  const { t } = useTranslation();
  const { connect } = useWalletStore();
  const { push } = useToastStore();
  const [status, setStatus] = useState<ConnectStatus>("idle");

  async function handleConnect() {
    const installed = await isFreighterInstalled();
    if (!installed) {
      setStatus("no-extension");
      return;
    }

    setStatus("connecting");
    try {
      const key = await connectFreighter();
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

  return { handleConnect, status };
}
