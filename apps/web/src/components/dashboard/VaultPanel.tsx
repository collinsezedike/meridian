import { useState } from "react";
import { useVaults } from "../../hooks/useVaults";
import { usePositions } from "../../hooks/usePositions";
import { useVaultActions } from "../../hooks/useVaultActions";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { getWalletMeta } from "../../lib/wallet";
import { PositionSummary } from "./PositionSummary";
import { DepositTab } from "./DepositTab";
import { WithdrawTab } from "./WithdrawTab";
import { useTranslation } from "react-i18next";
import { PROTOCOL_LABEL } from "../../lib/protocolLabels";

function formatTvl(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

type Tab = "deposit" | "withdraw";

export function VaultPanel() {
  const { data, isLoading: vaultsLoading } = useVaults();
  const vaults = data?.vaults;
  const { t } = useTranslation();
  const { connected, publicKey } = useWalletStore();
  const {
    handleConnect,
    status: connectStatus,
    attemptedWalletId,
  } = useWalletConnect();
  const {
    data: positions = [],
    isError: positionsError,
    refetch: refetchPositions,
  } = usePositions(publicKey);
  const { deposit, withdraw, isDepositing, isWithdrawing } = useVaultActions();

  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");

  function onAmountKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const allowed = [
      "Backspace",
      "Delete",
      "Tab",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      ".",
    ];
    if (allowed.includes(e.key) || (e.key >= "0" && e.key <= "9")) return;
    e.preventDefault();
  }

  // Route to the server's recommendation: the highest-APY vault Meridian can
  // actually deposit into (excludes display-only protocols and risky pools).
  const bestVault = vaults?.find((v) => v.id === data?.recommendedVaultId);
  // Prefer the position that matches the recommended vault so deposits and
  // withdrawals target the same protocol. Fall back to positions[0] when no
  // match exists (e.g. funds are in a legacy vault that is no longer recommended)
  // so the balance remains visible and withdrawable.
  const position = bestVault
    ? (positions.find((p) => p.vaultId === bestVault.id) ?? positions[0])
    : positions[0];
  const hasPosition =
    position && Number.isFinite(position.deposited) && position.deposited > 0;

  async function handleDeposit() {
    if (!amount || !bestVault) return;
    // Only a position actually held in bestVault carries a share price
    // relevant to this deposit: `position` above can fall back to a
    // different vault's entry, and a first-time depositor has none at all.
    // In both cases there's no reliable price to derive a floor from, so
    // the deposit goes through with no slippage protection (min_shares_out
    // omitted, which the contract treats as "0") rather than guessing a
    // wrong floor that could revert every legitimate deposit with
    // SlippageExceeded — a 1:1 fallback assumption is wrong the moment the
    // vault has accrued any yield past inception.
    const bestVaultPosition = positions.find((p) => p.vaultId === bestVault.id);
    const numAmount = parseFloat(amount);
    const minSharesOut =
      bestVaultPosition &&
      bestVaultPosition.shares > 0 &&
      bestVaultPosition.deposited > 0
        ? Math.max(
            0,
            ((numAmount * bestVaultPosition.shares) /
              bestVaultPosition.deposited) *
              0.995
          ).toFixed(7)
        : undefined;
    const ok = await deposit(
      amount,
      bestVault.id,
      bestVault.asset,
      minSharesOut
    );
    if (ok) setAmount("");
  }

  async function handleWithdraw() {
    if (!amount || !bestVault || !position) return;
    if (parseFloat(amount) > position.shares) return;
    const numShares = parseFloat(amount);
    const expectedUsdc =
      position.shares > 0
        ? (numShares * position.deposited) / position.shares
        : numShares;
    const minUsdcOut = Math.max(0, expectedUsdc * 0.995).toFixed(7);
    const ok = await withdraw(
      amount,
      position.vaultId,
      bestVault.asset,
      minUsdcOut
    );
    if (ok) setAmount("");
  }

  function handleTabChange(next: Tab) {
    setTab(next);
    setAmount("");
  }

  return (
    <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">
      {/* Hero — identity + stats */}
      <div className="px-7 pt-7 pb-6">
        {/* Identity row */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            {/* USDC logo */}
            <svg
              className="w-10 h-10 shrink-0"
              viewBox="0 0 2000 2000"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z"
                fill="#2775ca"
              />
              <path
                d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z"
                fill="#fff"
              />
              <path
                d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z"
                fill="#fff"
              />
            </svg>
            <div>
              <p className="text-xs text-gray-500">Meridian</p>
              <p className="text-sm font-semibold text-white">USDC Vault</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500 mb-0.5">
              {t("vaultPanel.network")}
            </p>
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
              <p className="text-xs text-gray-500 mb-1.5">
                {t("vaultPanel.apy")}
              </p>
              <div className="flex items-baseline gap-0.5">
                <span className="text-5xl font-black text-emerald-400 tabular-nums tracking-tight">
                  {bestVault.apy.toFixed(2)}
                </span>
                <span className="text-xl font-bold text-emerald-600">%</span>
              </div>
            </div>
            <div className="pb-1 sm:text-center">
              <p className="text-xs text-gray-500 mb-1.5">
                {t("vaultPanel.tvl")}
              </p>
              <p className="text-lg font-bold text-white">
                {formatTvl(bestVault.tvl)}
              </p>
            </div>
            <div className="pb-1 sm:text-right">
              <p className="text-xs text-gray-500 mb-1.5">
                {t("vaultPanel.route")}
              </p>
              <p className="text-lg font-bold text-white">
                {PROTOCOL_LABEL[bestVault.protocol] ?? bestVault.protocol}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            {t("vaultPanel.noLiveRateData")}
          </p>
        )}
      </div>

      {/* Position summary */}
      {connected && hasPosition && position && (
        <PositionSummary position={position} />
      )}

      {/* Position load error — deposit/withdraw stay usable, only the
          position summary is affected. */}
      {connected && positionsError && (
        <div className="mx-7 my-5 rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3.5 flex items-center justify-between gap-3">
          <p className="text-sm text-amber-400">
            {t("vaultPanel.positionsError")}
          </p>
          <button
            onClick={() => void refetchPositions()}
            className="shrink-0 rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Tab switcher */}
      {connected && (
        <div className="flex border-b border-gray-800">
          {(["deposit", "withdraw"] as Tab[]).map((tabId) => (
            <button
              key={tabId}
              data-testid={`vault-tab-${tabId}`}
              onClick={() => handleTabChange(tabId)}
              className={`flex-1 py-3 text-sm font-semibold transition-colors duration-150 ${
                tab === tabId
                  ? "text-white border-b-2 border-emerald-500"
                  : "text-gray-600 hover:text-gray-400"
              }`}
            >
              {t(`vaultPanel.${tabId}`)}
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
                href={getWalletMeta(attemptedWalletId).installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center w-full rounded-xl border border-amber-800/70 bg-amber-950/20 hover:border-amber-700 text-amber-400 hover:text-amber-300 text-sm font-medium py-3 transition-colors duration-150"
              >
                {t("common.installWallet", {
                  name: getWalletMeta(attemptedWalletId).name,
                })}
              </a>
            ) : (
              <button
                onClick={() => void handleConnect()}
                disabled={connectStatus === "connecting"}
                className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3 transition-all duration-150 disabled:cursor-not-allowed"
              >
                {connectStatus === "connecting"
                  ? t("common.connecting")
                  : t("common.connectWallet")}
              </button>
            )}
          </div>
        ) : tab === "deposit" ? (
          <DepositTab
            amount={amount}
            onAmountChange={setAmount}
            onAmountKeyDown={onAmountKeyDown}
            bestVault={bestVault}
            position={position}
            hasPosition={!!hasPosition}
            isDepositing={isDepositing}
            onSubmit={handleDeposit}
          />
        ) : (
          <WithdrawTab
            amount={amount}
            onAmountChange={setAmount}
            onAmountKeyDown={onAmountKeyDown}
            bestVault={bestVault}
            position={position}
            hasPosition={!!hasPosition}
            isWithdrawing={isWithdrawing}
            onSubmit={handleWithdraw}
          />
        )}
      </div>
    </div>
  );
}
