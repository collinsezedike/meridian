import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";
import { shortenAddress } from "@meridian/shared";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { WALLETS, getWalletMeta, type WalletId } from "../../lib/wallet";
import { Copy, Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function WalletConnect() {
  const { t } = useTranslation();
  const { connected, publicKey, disconnect } = useWalletStore();
  const { push } = useToastStore();
  const { handleConnect, status, attemptedWalletId } = useWalletConnect();
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [installedById, setInstalledById] = useState<
    Partial<Record<WalletId, boolean>>
  >({});
  const pickerRef = useRef<HTMLDivElement>(null);

  // Refreshed on every open rather than once on mount: extension install
  // state can change between opens without a page reload.
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    void Promise.all(
      WALLETS.map(async (w) => [w.id, await w.adapter.isInstalled()] as const)
    ).then((entries) => {
      if (!cancelled) setInstalledById(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onOutsideClick(e: MouseEvent) {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [pickerOpen]);

  const handleCopy = async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      push("error", t("walletConnect.copyFailed"));
    }
  };

  function handleDisconnect() {
    disconnect();
    // So a later reconnect starts from a closed picker rather than one left
    // open from before this disconnect (the picker's own JSX isn't rendered
    // at all while connected, so it can't close itself via a click).
    setPickerOpen(false);
    push("info", t("walletConnect.walletDisconnected"));
  }

  async function handlePick(walletId: WalletId) {
    setPickerOpen(false);
    await handleConnect(walletId);
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
    const meta = getWalletMeta(attemptedWalletId);
    return (
      <a
        href={meta.installUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm border border-amber-800 rounded-lg px-4 py-2 font-medium text-amber-400 hover:border-amber-600 hover:text-amber-300 transition-colors duration-150"
      >
        {t("common.installWallet", { name: meta.name })}
      </a>
    );
  }

  return (
    <div className="relative flex" ref={pickerRef}>
      {/* Plain click connects through whichever wallet is already selected
          (Freighter by default), unchanged from before the picker existed —
          the picker itself is the separate caret beside it. */}
      <button
        onClick={() => void handleConnect()}
        disabled={status === "connecting"}
        className="text-sm border border-gray-700 rounded-l-lg pl-4 pr-3 py-2 font-medium text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status === "connecting"
          ? t("common.connecting")
          : t("common.connectWallet")}
      </button>
      <button
        data-testid="wallet-picker-toggle"
        onClick={() => setPickerOpen((open) => !open)}
        disabled={status === "connecting"}
        aria-label={t("walletConnect.chooseWallet")}
        title={t("walletConnect.chooseWallet")}
        className="text-sm border border-l-0 border-gray-700 rounded-r-lg px-2 text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ChevronDown size={14} />
      </button>

      {pickerOpen && (
        <div
          data-testid="wallet-picker-menu"
          className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-gray-800 bg-[#161b22] shadow-xl shadow-black/40 overflow-hidden z-10"
        >
          {WALLETS.map((w) => (
            <button
              key={w.id}
              data-testid={`wallet-picker-option-${w.id}`}
              onClick={() => void handlePick(w.id)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white transition-colors duration-150"
            >
              <span>{w.name}</span>
              {installedById[w.id] === true && (
                <span className="text-xs text-emerald-400">
                  {t("walletConnect.installed")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
