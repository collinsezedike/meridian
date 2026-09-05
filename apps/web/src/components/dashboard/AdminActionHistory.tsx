import { useAdminHistory } from "../../hooks/useAdminHistory";
import { useTranslation } from "react-i18next";

const ACTION_BADGE: Record<string, { label: string; className: string }> = {
  set_admin: {
    label: "Set Admin",
    className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
  set_paused: {
    label: "Paused",
    className: "bg-red-500/15 text-red-400 border-red-500/30",
  },
  set_adapter: {
    label: "Adapter",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  },
  migrate_adapter: {
    label: "Migrate",
    className: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  },
  transfer_admin: {
    label: "Transfer Admin",
    className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
  accept_admin: {
    label: "Accept Admin",
    className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
};

const EXPLORER_BASE: Record<string, string> = {
  testnet: "https://stellar.expert/explorer/testnet/tx",
  mainnet: "https://stellar.expert/explorer/public/tx",
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

interface AdminActionHistoryProps {
  vaultId: string;
  network: "testnet" | "mainnet";
  isAdmin?: boolean;
}

export function AdminActionHistory({
  vaultId,
  network,
  isAdmin,
}: AdminActionHistoryProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useAdminHistory(
    isAdmin ? vaultId : null
  );

  if (!isAdmin) {
    return null;
  }

  const actions = data?.actions ?? [];

  return (
    <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">
      <div className="px-7 pt-7 pb-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          {t("adminHistory.title", "Admin Action History")}
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          {t(
            "adminHistory.subtitle",
            "Chronological log of vault administration calls"
          )}
        </p>
      </div>

      <div className="px-7 pb-7">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-12 bg-gray-800/50 rounded-xl animate-pulse"
              />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-xl border border-red-900/50 bg-red-950/20 px-4 py-3">
            <p className="text-sm text-red-400">
              {t("adminHistory.error", "Failed to load admin history")}
            </p>
          </div>
        ) : actions.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-8 text-center">
            <p className="text-sm text-gray-500">
              {t("adminHistory.empty", "No admin actions recorded yet")}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {actions.map((action) => {
              const badge = ACTION_BADGE[action.type] ?? {
                label: action.type,
                className: "bg-gray-500/15 text-gray-400 border-gray-500/30",
              };
              const explorerUrl =
                EXPLORER_BASE[network] + "/" + action.transactionHash;

              return (
                <div
                  key={action.id}
                  className="flex items-center gap-4 rounded-xl border border-gray-800 bg-[#0d1117] px-4 py-3 hover:border-gray-700 transition-colors duration-150"
                >
                  <span
                    className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs font-semibold ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-300 truncate">
                      {action.summary}
                    </p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {action.sourceAccount.slice(0, 8)}...
                      {action.sourceAccount.slice(-4)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-gray-500">
                      {formatTimestamp(action.timestamp)}
                    </p>
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors duration-150"
                    >
                      {t("adminHistory.viewTx", "View tx")}
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
