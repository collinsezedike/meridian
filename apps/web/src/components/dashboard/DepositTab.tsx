import { useTranslation } from "react-i18next";
import { AmountInput } from "../ui/AmountInput";
import type { ApiPosition, ApiVault } from "../../lib/api";
import { formatUsd } from "../../lib/format";

interface DepositTabProps {
  amount: string;
  onAmountChange: (value: string) => void;
  onAmountKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  bestVault: ApiVault | undefined;
  position: ApiPosition | undefined;
  hasPosition: boolean;
  showRiskDisclosure: boolean;
  onAcknowledgeRisk: () => void;
  isDepositing: boolean;
  onSubmit: () => void;
}

export function DepositTab({
  amount,
  onAmountChange,
  onAmountKeyDown,
  bestVault,
  position,
  hasPosition,
  showRiskDisclosure,
  onAcknowledgeRisk,
  isDepositing,
  onSubmit,
}: DepositTabProps) {
  const { t, i18n } = useTranslation();

  return (
    <div className="space-y-4">
      {showRiskDisclosure && (
        <section
          data-testid="deposit-risk-disclosure"
          className="rounded-xl border border-amber-800/70 bg-amber-950/20 p-4 space-y-3"
          aria-labelledby="deposit-risk-disclosure-title"
        >
          <h3
            id="deposit-risk-disclosure-title"
            className="text-sm font-semibold text-amber-300"
          >
            {t("vaultPanel.riskDisclosure.title")}
          </h3>
          <p className="text-xs leading-relaxed text-amber-200/90">
            {t("vaultPanel.riskDisclosure.description")}
          </p>
          <ul className="space-y-2 text-xs leading-relaxed text-amber-200/80">
            <li>{t("vaultPanel.riskDisclosure.smartContractRisk")}</li>
            <li>{t("vaultPanel.riskDisclosure.adapterRisk")}</li>
          </ul>
          <label className="flex items-start gap-2 text-xs text-amber-200">
            <input
              type="checkbox"
              data-testid="deposit-risk-acknowledgement"
              onChange={(event) => {
                if (event.currentTarget.checked) onAcknowledgeRisk();
              }}
              className="mt-0.5"
            />
            <span>{t("vaultPanel.riskDisclosure.acknowledgement")}</span>
          </label>
        </section>
      )}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-500">
            {t("vaultPanel.amount")}
          </span>
          {hasPosition && position && (
            <span className="text-xs text-gray-600">
              {t("vaultPanel.balance")}:{" "}
              {formatUsd(position.deposited, i18n.language)}
            </span>
          )}
        </div>
        <AmountInput
          currency="USDC"
          value={amount}
          onChange={onAmountChange}
          onKeyDown={onAmountKeyDown}
        />
      </div>
      <button
        data-testid="vault-deposit-submit"
        onClick={onSubmit}
        disabled={
          !amount ||
          !bestVault ||
          isDepositing ||
          showRiskDisclosure ||
          parseFloat(amount) <= 0 ||
          Number.isNaN(parseFloat(amount))
        }
        className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3.5 transition-all duration-150 disabled:cursor-not-allowed"
      >
        {isDepositing ? t("vaultPanel.waiting") : t("vaultPanel.deposit")}
      </button>
    </div>
  );
}
