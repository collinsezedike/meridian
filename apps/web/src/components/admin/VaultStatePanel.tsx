import { useTranslation } from "react-i18next";
import { useVaultState } from "../../hooks/useVaultState";
import { PROTOCOL_LABEL } from "../../lib/protocolLabels";

function formatAmount(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function VaultStatePanel() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useVaultState();

  return (
    <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">
      <div className="px-6 pt-5 pb-4 border-b border-gray-800">
        <p className="text-sm font-semibold text-white">
          {t("admin.vaultState.title")}
        </p>
      </div>

      <div className="px-6 py-5">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-16 bg-gray-800 rounded animate-pulse" />
                <div className="h-5 w-20 bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : isError || !data ? (
          <div className="rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3.5 flex items-center justify-between gap-3">
            <p className="text-sm text-amber-400">
              {t("admin.vaultState.loadError")}
            </p>
            <button
              onClick={() => void refetch()}
              className="shrink-0 rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-y-5 gap-x-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">
                {t("admin.vaultState.adapter")}
              </p>
              <p className="text-sm font-semibold text-white">
                {PROTOCOL_LABEL[data.protocol] ?? data.protocol}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">
                {t("admin.vaultState.status")}
              </p>
              <span
                data-testid="vault-state-badge"
                className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  data.paused
                    ? "bg-amber-950/40 text-amber-400 border border-amber-800/70"
                    : "bg-emerald-950/40 text-emerald-400 border border-emerald-800/70"
                }`}
              >
                {t(
                  data.paused
                    ? "admin.vaultState.paused"
                    : "admin.vaultState.active"
                )}
              </span>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">
                {t("admin.vaultState.totalShares")}
              </p>
              <p className="text-sm font-semibold text-white tabular-nums">
                {formatAmount(data.totalShares)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">
                {t("admin.vaultState.totalAssets")}
              </p>
              <p className="text-sm font-semibold text-white tabular-nums">
                {formatAmount(data.totalAssets)}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
