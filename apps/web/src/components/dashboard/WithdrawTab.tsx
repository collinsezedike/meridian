import { useTranslation } from "react-i18next";
import { AmountInput } from "../ui/AmountInput";
import type { ApiPosition, ApiVault } from "../../lib/api";

interface WithdrawTabProps {
  amount: string;
  onAmountChange: (value: string) => void;
  onAmountKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  bestVault: ApiVault | undefined;
  position: ApiPosition | undefined;
  hasPosition: boolean;
  isWithdrawing: boolean;
  onSubmit: () => void;
}

export function WithdrawTab({
  amount,
  onAmountChange,
  onAmountKeyDown,
  bestVault,
  position,
  hasPosition,
  isWithdrawing,
  onSubmit,
}: WithdrawTabProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      {!hasPosition ? (
        <p className="text-sm text-gray-500 py-2">{t("vaultPanel.position")}</p>
      ) : (
        <>
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-gray-500">
                {t("vaultPanel.amount")}
              </span>
              <button
                data-testid="vault-withdraw-max"
                onClick={() => onAmountChange(position!.shares.toFixed(7))}
                className="text-xs text-emerald-500 hover:text-emerald-400 transition-colors duration-150"
              >
                {t("vaultPanel.max")}: {position!.shares.toFixed(2)}
              </button>
            </div>
            <AmountInput
              currency="mUSDC"
              value={amount}
              onChange={onAmountChange}
              onKeyDown={onAmountKeyDown}
            />
          </div>
          <button
            data-testid="vault-withdraw-submit"
            onClick={onSubmit}
            disabled={
              !amount ||
              !bestVault ||
              isWithdrawing ||
              parseFloat(amount) > (position?.shares ?? 0)
            }
            className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3.5 transition-all duration-150 disabled:cursor-not-allowed"
          >
            {isWithdrawing ? t("vaultPanel.waiting") : t("vaultPanel.withdraw")}
          </button>
        </>
      )}
    </div>
  );
}
