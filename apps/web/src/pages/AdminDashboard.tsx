import { useTranslation } from "react-i18next";
import { useWalletStore } from "../store/wallet";
import { useWalletConnect } from "../hooks/useWalletConnect";
import { useIsAdminWallet } from "../hooks/useIsAdminWallet";
import { KeeperHealthPanel } from "../components/admin/KeeperHealthPanel";
import { VaultStatePanel } from "../components/admin/VaultStatePanel";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";

// Minimal admin route shell (#615) built only so the Keeper Health and Vault
// State panels have somewhere to live — #614 ("Admin dashboard: auth gate")
// is the real, separately-scoped auth gate for this route and is still
// unbuilt as of this file. useIsAdminWallet is a client-side placeholder,
// not the real thing; #614 should replace it wholesale rather than extend
// it.
export function AdminDashboard() {
  const { t } = useTranslation();
  const { connected } = useWalletStore();
  const { handleConnect, status: connectStatus } = useWalletConnect();
  const isAdmin = useIsAdminWallet();

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-lg font-extrabold text-white mb-6">
        {t("admin.title")}
      </h1>

      {!connected ? (
        <button
          onClick={() => void handleConnect()}
          disabled={connectStatus === "connecting"}
          className="rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold py-3 px-6 transition-all duration-150 disabled:cursor-not-allowed"
        >
          {t("admin.connectPrompt")}
        </button>
      ) : !isAdmin ? (
        <p className="text-sm text-amber-400">{t("admin.notAuthorized")}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <ErrorBoundary>
            <KeeperHealthPanel />
          </ErrorBoundary>
          <ErrorBoundary>
            <VaultStatePanel />
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
