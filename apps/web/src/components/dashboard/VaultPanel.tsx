import { useState } from "react";
import { useVaults } from "../../hooks/useVaults";
import { usePositions } from "../../hooks/usePositions";
import { useVaultActions } from "../../hooks/useVaultActions";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { useTranslation } from "react-i18next";

const PROTOCOL_LABEL: Record<string, string> = {
  blend: "Blend Capital",
  defindex: "DeFindex",
};


function formatUsd(value: number , locale : string) {
  return value.toLocaleString(
    locale === "fr" ? "fr-FR" : "en-US",
    {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTvl(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

type Tab = "deposit" | "withdraw";

export function VaultPanel() {
  const { data, isLoading: vaultsLoading } = useVaults();
  const vaults = data?.vaults;
  const { t, i18n } = useTranslation();
  const { connected, publicKey } = useWalletStore();
  const { handleConnect, status: connectStatus } = useWalletConnect();
  const { data: positions = [] } = usePositions(publicKey);
  const { deposit, withdraw, addTrustline, needsTrustline, isDepositing, isWithdrawing, clearNeedsTrustline } = useVaultActions();

  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");

  function onAmountKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const allowed = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End", "."];
    if (allowed.includes(e.key) || (e.key >= "0" && e.key <= "9")) return;
    e.preventDefault();
  }

  // Route to the server's recommendation: the highest-APY vault Meridian can
  // actually deposit into (excludes display-only protocols and risky pools).
  const bestVault = vaults?.find((v) => v.id === data?.recommendedVaultId);
  // Single-vault architecture: the user holds at most one position. Revisit if multi-vault is added.
  const position = positions[0];
  const hasPosition = position && position.deposited > 0;

  async function handleDeposit() {
    if (!amount || !bestVault) return;
    const ok = await deposit(amount, bestVault.id, bestVault.asset);
    if (ok) setAmount("");
  }

  async function handleWithdraw() {
    if (!amount || !bestVault) return;
    const ok = await withdraw(amount, bestVault.id, bestVault.asset);
    if (ok) setAmount("");
  }

  function handleTabChange(next: Tab) {
    setTab(next);
    setAmount("");
    clearNeedsTrustline();
  }

  return (
    <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">

      {/* Hero — identity + stats */}
      <div className="px-7 pt-7 pb-6">
        {/* Identity row */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            {/* USDC logo */}
            <svg className="w-10 h-10 shrink-0" viewBox="0 0 2000 2000" xmlns="http://www.w3.org/2000/svg">
              <path d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z" fill="#2775ca"/>
              <path d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z" fill="#fff"/>
              <path d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z" fill="#fff"/>
            </svg>
            <div>
              <p className="text-xs text-gray-500">Meridian</p>
              <p className="text-sm font-semibold text-white">USDC Vault</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500 mb-0.5">{t("vaultPanel.network")}</p>
            <p className="text-xs font-semibold text-gray-300">Stellar</p>
          </div>
        </div>

        {/* Stats row */}
        {vaultsLoading ? (
          <div className="flex justify-between">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-10 bg-gray-800 rounded animate-pulse" />
                <div className="h-8 w-16 bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : bestVault ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs text-gray-500 mb-1.5">{t("vaultPanel.apy")}</p>
              <div className="flex items-baseline gap-0.5">
                <span className="text-5xl font-black text-emerald-400 tabular-nums tracking-tight">
                  {bestVault.apy.toFixed(2)}
                </span>
                <span className="text-xl font-bold text-emerald-600">%</span>
              </div>
            </div>
            <div className="pb-1 sm:text-center">
              <p className="text-xs text-gray-500 mb-1.5">{t("vaultPanel.tvl")}</p>
              <p className="text-lg font-bold text-white">{formatTvl(bestVault.tvl)}</p>
            </div>
            <div className="pb-1 sm:text-right">
              <p className="text-xs text-gray-500 mb-1.5">{t("vaultPanel.route")}</p>
              <p className="text-lg font-bold text-white">
                {PROTOCOL_LABEL[bestVault.protocol] ?? bestVault.protocol}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">{t("vaultPanel.noLiveRateData")}</p>
        )}
      </div>

      {/* Position summary */}
      {connected && hasPosition && (
        <div className="mx-7 my-5 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3.5 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-500 mb-1">{t("vaultPanel.yourPosition")}</p>
            <p className="text-base font-bold text-white">{formatUsd(position.deposited, i18n.language)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500 mb-1">{t("vaultPanel.earned")}</p>
            <p className="text-base font-bold text-emerald-400">+{formatUsd(position.earned, i18n.language)}</p>
          </div>
        </div>
      )}

      {/* Tab switcher */}
      {connected && (
        <div className="flex border-b border-gray-800">
          {(["deposit", "withdraw"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => handleTabChange(t)}
              className={`flex-1 py-3 text-sm font-semibold transition-colors duration-150 ${
                tab === t
                  ? "text-white border-b-2 border-emerald-500"
                  : "text-gray-600 hover:text-gray-400"
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Action area */}
      <div className="px-7 py-6">
        {!connected ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-400 leading-relaxed">
              {t("vaultPanel.connectUSDC")}
            </p>
            {connectStatus === "no-extension" ? (
              <a
                href="https://freighter.app"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center w-full rounded-xl border border-amber-800/70 bg-amber-950/20 hover:border-amber-700 text-amber-400 hover:text-amber-300 text-sm font-medium py-3 transition-colors duration-150"
              >
                {t("common.installFreighter")}
              </a>
            ) : (
              <button
                onClick={handleConnect}
                disabled={connectStatus === "connecting"}
                className="w-full rounded-xl border border-gray-700 bg-gray-900/50 hover:border-gray-500 hover:bg-gray-900 hover:text-white text-gray-300 text-sm font-semibold py-3 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {connectStatus === "connecting" ? t("common.connecting") : t("common.connectWallet")}
              </button>
            )}
          </div>
        ) : tab === "deposit" ? (
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-500">{t("vaultPanel.amount")}</span>
                {hasPosition && (
                  <span className="text-xs text-gray-600">
                    {t("vaultPanel.balance")}: {formatUsd(position.deposited, i18n.language)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-900/70 px-4 py-3.5 focus-within:border-gray-500 transition-colors duration-150">
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount((e.target as HTMLInputElement).value)}
                  onKeyDown={onAmountKeyDown}
                  className="flex-1 min-w-0 bg-transparent text-white text-xl font-semibold outline-none placeholder:text-gray-700 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="rounded-lg bg-gray-800 border border-gray-700 px-2.5 py-1 text-xs font-semibold text-gray-300 shrink-0">
                  USDC
                </span>
              </div>
            </div>
            {needsTrustline && (
              <button
                onClick={addTrustline}
                className="w-full rounded-xl border border-amber-800/70 bg-amber-950/20 hover:border-amber-700 text-amber-400 hover:text-amber-300 text-sm font-medium py-3 transition-colors duration-150"
              >
                {t("vaultPanel.addAssets")}
              </button>
            )}
            <button
              onClick={handleDeposit}
              disabled={!amount || !bestVault || isDepositing}
              className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3.5 transition-all duration-150 disabled:cursor-not-allowed"
            >
              {isDepositing ? t("vaultPanel.waiting") : t("vaultPanel.deposit")}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {!hasPosition ? (
              <p className="text-sm text-gray-500 py-2">{t("vaultPanel.position")}</p>
            ) : (
              <>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-500">{t("vaultPanel.amount")}</span>
                    <button
                      onClick={() => setAmount(position.shares.toFixed(7))}
                      className="text-xs text-emerald-500 hover:text-emerald-400 transition-colors duration-150"
                    >
                      Max: {position.shares.toFixed(2)}
                    </button>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-900/70 px-4 py-3.5 focus-within:border-gray-500 transition-colors duration-150">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount((e.target as HTMLInputElement).value)}
                      onKeyDown={onAmountKeyDown}
                      className="flex-1 min-w-0 bg-transparent text-white text-xl font-semibold outline-none placeholder:text-gray-700 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="rounded-lg bg-gray-800 border border-gray-700 px-2.5 py-1 text-xs font-semibold text-gray-300 shrink-0">
                      mUSDC
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleWithdraw}
                  disabled={!amount || !bestVault || isWithdrawing}
                  className="w-full rounded-xl border border-gray-700 bg-gray-900/50 hover:border-gray-500 hover:bg-gray-900 hover:text-white text-gray-300 text-sm font-semibold py-3.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isWithdrawing ? t("vaultPanel.waiting") : t("vaultPanel.withdraw")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
