import { useTranslation } from "react-i18next";
import { APP_ADDRESSES, APP_NETWORK } from "@meridian/shared";
import { useVaultState } from "../hooks/useVaultState";
import { VaultStatePanel } from "../components/admin/VaultStatePanel";
import { AdminActionHistory } from "../components/dashboard/AdminActionHistory";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";

// Migration cooldown is a compile-time Rust constant
// (packages/contracts/vault/src/storage.rs's MIN_LEDGER_GAP), not something
// queryable on-chain, so it's hardcoded here rather than fetched. Slippage
// tolerance and TTL thresholds are deliberately not shown yet: the vault
// currently has no admin-configurable slippage ceiling at all (#557, open)
// and the TTL-extension mechanism (#553) hasn't landed on a deployed
// contract yet, so displaying either now would misrepresent what's actually
// live. Add them here once their respective PRs merge.
const MIGRATION_COOLDOWN_LEDGERS = 12;

const EXPLORER_CONTRACT_BASE: Record<string, string> = {
  testnet: "https://stellar.expert/explorer/testnet/contract",
  mainnet: "https://stellar.expert/explorer/public/contract",
};

interface AddressRow {
  labelKey: string;
  address: string | undefined;
}

function AddressList({ rows }: { rows: AddressRow[] }) {
  const { t } = useTranslation();
  const explorerBase = EXPLORER_CONTRACT_BASE[APP_NETWORK.network];

  return (
    <div className="divide-y divide-gray-800">
      {rows.map((row) => (
        <div
          key={row.labelKey}
          className="flex items-center justify-between gap-4 py-3.5"
        >
          <span className="text-sm text-gray-400 shrink-0">
            {t(row.labelKey)}
          </span>
          {row.address ? (
            <a
              href={`${explorerBase}/${row.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors duration-150 font-mono truncate"
              title={row.address}
            >
              {row.address.slice(0, 6)}...{row.address.slice(-6)}
            </a>
          ) : (
            <span className="text-sm text-gray-600">
              {t("status.addresses.notDeployed")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function StatusPage() {
  const { t } = useTranslation();
  const { data: vaultState } = useVaultState();

  const addressRows: AddressRow[] = [
    {
      labelKey: "status.addresses.vault",
      address: APP_ADDRESSES.vault || undefined,
    },
    {
      labelKey: "status.addresses.adapter",
      address: vaultState?.adapterId,
    },
    {
      labelKey: "status.addresses.musdc",
      address: APP_ADDRESSES.musdc || undefined,
    },
    {
      labelKey: "status.addresses.usdc",
      address: APP_ADDRESSES.usdc || undefined,
    },
    {
      labelKey: "status.addresses.eurc",
      address: APP_ADDRESSES.eurc || undefined,
    },
  ];

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-lg font-extrabold text-white">
              {t("status.title")}
            </h1>
            <span className="rounded-full border border-gray-700 px-2.5 py-0.5 text-xs font-medium text-gray-400 uppercase">
              {APP_NETWORK.network}
            </span>
          </div>
          <p className="text-sm text-gray-500">{t("status.subtitle")}</p>
        </div>

        <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40 px-6">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider pt-6 pb-1">
            {t("status.addresses.title")}
          </h2>
          <AddressList rows={addressRows} />
        </div>

        <ErrorBoundary>
          <VaultStatePanel />
        </ErrorBoundary>

        <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40 px-6 py-6">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            {t("status.parameters.title")}
          </h2>
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-gray-400">
              {t("status.parameters.migrationCooldown")}
            </span>
            <span className="text-sm text-white tabular-nums">
              {t("status.parameters.migrationCooldownValue", {
                ledgers: MIGRATION_COOLDOWN_LEDGERS,
              })}
            </span>
          </div>
          <p className="text-xs text-gray-600 mt-4">
            {t("status.parameters.note")}
          </p>
        </div>

        <ErrorBoundary>
          <AdminActionHistory
            vaultId="meridian-usdc"
            network={APP_NETWORK.network}
            isAdmin
          />
        </ErrorBoundary>

        <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40 px-6 py-6">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">
            {t("status.audit.title")}
          </h2>
          <p className="text-sm text-gray-500">
            {t("status.audit.notYetAvailable")}
          </p>
        </div>
      </div>
    </div>
  );
}
