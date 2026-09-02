import { useTranslation } from "react-i18next";
import { APP_NETWORK } from "@meridian/shared";
import { KeeperHealthPanel } from "../components/admin/KeeperHealthPanel";
import { VaultStatePanel } from "../components/admin/VaultStatePanel";
import { AdminActionHistory } from "../components/dashboard/AdminActionHistory";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";

// The panel shell for the admin route (#615, #616). Auth is handled entirely
// by AdminLogin, which only renders this once the connected wallet has been
// verified against the vault's live get_admin — this component assumes that
// check has already passed and does not re-gate anything itself.
export function AdminDashboard() {
  const { t } = useTranslation();

  return (
    <div className="max-w-4xl mx-auto px-6 py-10 space-y-6">
      <h1 className="text-lg font-extrabold text-white mb-6">
        {t("admin.title")}
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ErrorBoundary>
          <KeeperHealthPanel />
        </ErrorBoundary>
        <ErrorBoundary>
          <VaultStatePanel />
        </ErrorBoundary>
      </div>

      <AdminActionHistory
        vaultId="meridian-usdc"
        network={APP_NETWORK.network}
        isAdmin
      />
    </div>
  );
}
