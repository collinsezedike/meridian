import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useKeeperHealth } from "../../hooks/useKeeperHealth";
import type { KeeperHealthEntry } from "../../lib/api";

// How often the "overdue by Xm" readout advances. Coarser than a clock tick
// since formatDuration below only shows whole minutes anyway.
const NOW_TICK_MS = 30_000;

const KEEPER_LABEL_KEY: Record<KeeperHealthEntry["id"], string> = {
  accrual: "admin.keeperHealth.accrual",
  migration: "admin.keeperHealth.migration",
};

// Coarse, human-friendly duration for the last-run/overdue-by readouts —
// this is a health dashboard, not a stopwatch, so "5m" is more useful at a
// glance than "5m 12s".
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function KeeperHealthPanel() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useKeeperHealth();
  // Date.now() is impure and can't be called during render (react/purity) —
  // this also keeps "overdue by Xm" advancing on its own between refetches.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">
      <div className="px-6 pt-5 pb-4 border-b border-gray-800">
        <p className="text-sm font-semibold text-white">
          {t("admin.keeperHealth.title")}
        </p>
      </div>

      <div className="px-6 py-5">
        {isLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="h-4 w-32 bg-gray-800 rounded animate-pulse" />
                <div className="h-4 w-20 bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : isError || !data ? (
          <div className="rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3.5 flex items-center justify-between gap-3">
            <p className="text-sm text-amber-400">
              {t("admin.keeperHealth.loadError")}
            </p>
            <button
              onClick={() => void refetch()}
              className="shrink-0 rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <ul className="space-y-4">
            {data.keepers.map((keeper) => (
              <li
                key={keeper.id}
                data-testid={`keeper-row-${keeper.id}`}
                className="flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    data-testid={`keeper-status-dot-${keeper.id}`}
                    className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                      keeper.healthy ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <span className="text-sm font-medium text-white truncate">
                    {t(KEEPER_LABEL_KEY[keeper.id])}
                  </span>
                </div>
                <div className="text-right shrink-0">
                  <p
                    className={`text-xs font-semibold ${
                      keeper.healthy ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {t(
                      keeper.healthy
                        ? "admin.keeperHealth.healthy"
                        : "admin.keeperHealth.stalled"
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {keeper.lastSuccessMs === null
                      ? t("admin.keeperHealth.never")
                      : keeper.healthy
                        ? t("admin.keeperHealth.interval", {
                            interval: formatDuration(keeper.intervalMs),
                          })
                        : t("admin.keeperHealth.overdueBy", {
                            duration: formatDuration(
                              now - keeper.lastSuccessMs
                            ),
                          })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
