import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

function explorerLink(
  network: "testnet" | "mainnet",
  contractId: string
): string {
  if (!contractId) return "#";
  return network === "mainnet"
    ? `https://stellar.expert/explorer/public/contract/${contractId}`
    : `https://stellar.expert/explorer/testnet/contract/${contractId}`;
}

function AddressRow({
  label,
  address,
  network,
}: {
  label: string;
  address: string;
  network: "testnet" | "mainnet";
}) {
  if (!address) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-gray-400">{label}</span>
        <span className="text-sm text-gray-600 italic">Not deployed</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-gray-400">{label}</span>
      <a
        href={explorerLink(network, address)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm text-sky-400 hover:text-sky-300 transition-colors"
      >
        <span className="font-mono">
          {address.slice(0, 6)}...{address.slice(-6)}
        </span>
        <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}

function NetworkCard({ network }: { network: "testnet" | "mainnet" }) {
  const { t } = useTranslation();
  const addrs = CONTRACT_ADDRESSES[network];
  const netConfig = STELLAR_NETWORKS[network];

  return (
    <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">
      <div className="px-7 pt-6 pb-4 border-b border-gray-800">
        <h2 className="text-lg font-bold text-white capitalize">{network}</h2>
        <p className="text-xs text-gray-500 mt-1 font-mono">
          {netConfig.rpcUrl}
        </p>
      </div>
      <div className="px-7 py-4 space-y-1">
        <AddressRow
          label={t("statusPage.vault")}
          address={addrs.vault}
          network={network}
        />
        <AddressRow
          label={t("statusPage.musdc")}
          address={addrs.musdc}
          network={network}
        />
        <AddressRow
          label={t("statusPage.usdc")}
          address={addrs.usdc}
          network={network}
        />
        <AddressRow
          label={t("statusPage.eurc")}
          address={addrs.eurc}
          network={network}
        />
        <AddressRow
          label={t("statusPage.blendPool")}
          address={addrs.blend.pool}
          network={network}
        />
        <AddressRow
          label={t("statusPage.defindexFactory")}
          address={addrs.defindex.factory}
          network={network}
        />
        <AddressRow
          label={t("statusPage.defindexVault")}
          address={addrs.defindex.vault}
          network={network}
        />
      </div>
    </div>
  );
}

export function StatusPage() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <header className="sticky top-0 z-50 border-b border-gray-800 bg-[#0d1117]/95 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="font-extrabold text-lg tracking-tight text-white">
            {t("statusPage.title")}
          </span>
          <a
            href="/app/"
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            {t("statusPage.backToApp")}
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        <div>
          <h1 className="text-3xl font-black tracking-tight mb-2">
            {t("statusPage.heading")}
          </h1>
          <p className="text-gray-400 text-sm max-w-2xl">
            {t("statusPage.description")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <NetworkCard network="testnet" />
          <NetworkCard network="mainnet" />
        </div>

        <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">
          <div className="px-7 pt-6 pb-4 border-b border-gray-800">
            <h2 className="text-lg font-bold text-white">
              {t("statusPage.parameters")}
            </h2>
          </div>
          <div className="px-7 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="py-2">
                <span className="text-sm text-gray-400">
                  Migration cooldown
                </span>
                <p className="text-sm text-white mt-1">
                  ~1 minute (MIN_LEDGER_GAP ledgers)
                </p>
              </div>
              <div className="py-2">
                <span className="text-sm text-gray-400">
                  Default max slippage
                </span>
                <p className="text-sm text-white mt-1">100 bps (1%)</p>
              </div>
              <div className="py-2">
                <span className="text-sm text-gray-400">
                  Default min improvement
                </span>
                <p className="text-sm text-white mt-1">50 bps (0.5%)</p>
              </div>
              <div className="py-2">
                <span className="text-sm text-gray-400">Function budget</span>
                <p className="text-sm text-white mt-1">50,000 ms</p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">
          <div className="px-7 pt-6 pb-4 border-b border-gray-800">
            <h2 className="text-lg font-bold text-white">
              {t("statusPage.pauseHistory")}
            </h2>
          </div>
          <div className="px-7 py-6">
            <p className="text-sm text-gray-500 italic">
              {t("statusPage.pauseHistoryPlaceholder")}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-800 bg-[#161b22] overflow-hidden shadow-xl shadow-black/40">
          <div className="px-7 pt-6 pb-4 border-b border-gray-800">
            <h2 className="text-lg font-bold text-white">
              {t("statusPage.audit")}
            </h2>
          </div>
          <div className="px-7 py-6">
            <p className="text-sm text-gray-500 italic">
              {t("statusPage.auditPlaceholder")}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
