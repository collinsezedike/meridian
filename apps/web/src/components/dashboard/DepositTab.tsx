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
  isDepositing,
  onSubmit,
}: DepositTabProps) {
  const { t, i18n } = useTranslation();

  return (
    <div className="space-y-4">
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
