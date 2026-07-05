import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";
import { shortenAddress } from "@meridian/shared";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { Copy, Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function WalletConnect() {
  const { t } = useTranslation();
  const { connected, publicKey, disconnect } = useWalletStore();
  const { push } = useToastStore();
  const { handleConnect, status } = useWalletConnect();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      push("error", "Failed to copy address");
    }
  };

  function handleDisconnect() {
    disconnect();
    push("info", t("walletConnect.walletDisconnected"));
  }

  if (connected && publicKey) {
    return (
      <div className="flex items-center gap-2 text-sm border border-gray-700 rounded-lg px-3 py-2 text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        <span>{shortenAddress(publicKey)}</span>
        <button
          onClick={handleCopy}
          title={
            copied ? t("walletConnect.copied") : t("walletConnect.copyAddress")
          }
          aria-label={
            copied ? t("walletConnect.copied") : t("walletConnect.copyAddress")
          }
          className="text-gray-400 hover:text-white transition-colors duration-150"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>

        <span className="text-gray-600">·</span>
        <button
          onClick={handleDisconnect}
          className="text-gray-400 hover:text-white transition-colors duration-150"
        >
          {t("walletConnect.disconnect")}
        </button>
      </div>
    );
  }

  if (status === "no-extension") {
    return (
      <a
        href="https://freighter.app"
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm border border-amber-800 rounded-lg px-4 py-2 font-medium text-amber-400 hover:border-amber-600 hover:text-amber-300 transition-colors duration-150"
      >
        {t("common.installFreighter")}
      </a>
    );
  }

  return (
    <button
      onClick={handleConnect}
      disabled={status === "connecting"}
      className="text-sm border border-gray-700 rounded-lg px-4 py-2 font-medium text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {status === "connecting"
        ? t("common.connecting")
        : t("common.connectWallet")}
    </button>
  );
}
