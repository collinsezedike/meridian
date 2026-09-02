import { useTranslation } from "react-i18next";
import type { ApiPosition } from "../../lib/api";
import { formatUsd } from "../../lib/format";

interface PositionSummaryProps {
  position: ApiPosition;
}

export function PositionSummary({ position }: PositionSummaryProps) {
  const { t, i18n } = useTranslation();

  return (
    <div className="mx-7 my-5 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3.5 flex items-center justify-between">
      <div>
        <p className="text-xs text-gray-500 mb-1">
          {t("vaultPanel.yourPosition")}
        </p>
        <p className="text-base font-bold text-white">
          {formatUsd(position.deposited, i18n.language)}
        </p>
      </div>
      <div className="text-right">
        <p className="text-xs text-gray-500 mb-1">{t("vaultPanel.earned")}</p>
        <p className="text-base font-bold text-emerald-400">
          +{formatUsd(position.earned, i18n.language)}
        </p>
      </div>
    </div>
  );
}
