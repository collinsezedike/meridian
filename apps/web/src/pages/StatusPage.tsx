import { useTranslation } from "react-i18next";
import { Shield, PauseCircle, FileText, ExternalLink, Activity } from "lucide-react";

interface ContractAddress {
  name: string;
  address: string;
  explorerUrl: string;
}

interface VaultParameter {
  label: string;
  value: string;
}

const CONTRACTS: ContractAddress[] = [
  {
    name: "Vault",
    address: import.meta.env.VITE_VAULT_CONTRACT_ID ?? "—",
    explorerUrl: "https://stellar.expert/explorer/public/contract/",
  },
  {
    name: "Blend Adapter",
    address: import.meta.env.VITE_BLEND_ADAPTER_CONTRACT_ID ?? "—",
    explorerUrl: "https://stellar.expert/explorer/public/contract/",
  },
  {
    name: "DeFindex Adapter",
    address: import.meta.env.VITE_DEFINDEX_ADAPTER_CONTRACT_ID ?? "—",
    explorerUrl: "https://stellar.expert/explorer/public/contract/",
  },
  {
    name: "mUSDC Token",
    address: import.meta.env.VITE_MUSDC_CONTRACT_ID ?? "—",
    explorerUrl: "https://stellar.expert/explorer/public/contract/",
  },
];

const PARAMETERS: VaultParameter[] = [
  { label: "Migration cooldown", value: "120 ledgers (~10 min)" },
  { label: "Max slippage cap", value: "500 bps (5%)" },
  { label: "Instance TTL", value: "30 days" },
  { label: "Position TTL", value: "120 days" },
];

export default function StatusPage() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <header className="sticky top-0 z-50 border-b border-gray-800 bg-[#0d1117]/95 backdrop-blur-sm pb-4">
        <div className="max-w-xl mx-auto px-6 h-20 flex items-end justify-between pb-4">
          <span className="font-extrabold text-lg tracking-tight text-white">
            {t("status.title", { defaultValue: "Vault Status" })}
          </span>
          <a
            href="/app/"
            className="text-sm text-gray-300 hover:text-white transition-colors"
          >
            {t("status.backToApp", { defaultValue: "Back to app" })}
          </a>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-6 py-10 space-y-8">
        {/* Contract Addresses */}
        <section>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-emerald-400" />
            {t("status.contracts", { defaultValue: "Contract Addresses" })}
          </h2>
          <div className="space-y-3">
            {CONTRACTS.map((c) => (
              <div
                key={c.name}
                className="flex items-center justify-between p-3 rounded-lg border border-gray-800 bg-gray-900/50"
              >
                <div>
                  <p className="text-sm font-medium text-gray-200">{c.name}</p>
                  <p className="text-xs font-mono text-gray-500 break-all">
                    {c.address}
                  </p>
                </div>
                {c.address !== "—" && (
                  <a
                    href={`${c.explorerUrl}${c.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 p-2 text-gray-400 hover:text-white transition-colors"
                    aria-label={t("status.viewOnExplorer", {
                      defaultValue: "View on explorer",
                    })}
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Parameters */}
        <section>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5 text-sky-400" />
            {t("status.parameters", { defaultValue: "Vault Parameters" })}
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {PARAMETERS.map((p) => (
              <div
                key={p.label}
                className="p-3 rounded-lg border border-gray-800 bg-gray-900/50"
              >
                <p className="text-xs text-gray-500">{p.label}</p>
                <p className="text-sm font-medium text-gray-200">{p.value}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Pause Status */}
        <section>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <PauseCircle className="w-5 h-5 text-amber-400" />
            {t("status.pauseHistory", { defaultValue: "Pause History" })}
          </h2>
          <p className="text-sm text-gray-400">
            {t("status.pauseHistoryDesc", {
              defaultValue:
                "Pause events are emitted on-chain and can be tracked via the event monitoring service (#707).",
            })}
          </p>
        </section>

        {/* Audit & Docs */}
        <section>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <FileText className="w-5 h-5 text-violet-400" />
            {t("status.audit", { defaultValue: "Audit & Documentation" })}
          </h2>
          <div className="space-y-2">
            <a
              href="https://github.com/drydocs/meridian/tree/main/apps/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-sky-400 hover:text-sky-300 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              {t("status.viewDocs", { defaultValue: "View documentation" })}
            </a>
            <a
              href="https://github.com/drydocs/meridian/blob/main/apps/docs/operations/mainnet-deployment.md"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-sky-400 hover:text-sky-300 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              {t("status.viewRunbook", { defaultValue: "Mainnet deployment runbook" })}
            </a>
          </div>
        </section>

        {/* Trust Note */}
        <footer className="pt-6 border-t border-gray-800 text-xs text-gray-500">
          <p>
            {t("status.trustNote", {
              defaultValue:
                "All contract addresses and parameters are verified on-chain. Do not trust; verify.",
            })}
          </p>
        </footer>
      </main>
    </div>
  );
}
