import { useCallback, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultPanel } from "./components/dashboard/VaultPanel";
import { WalletConnect } from "./components/onboarding/WalletConnect";
import { Toasts } from "./components/ui/Toasts";
import { useWalletStore } from "./store/wallet";
import { useTranslation } from "react-i18next";

const queryClient = new QueryClient();

function Dashboard() {
  const { t, i18n } = useTranslation();
  const toggleLanguage = useCallback(() => { 
    const newLang = i18n.language === "en" ? "fr" : "en";
    i18n.changeLanguage(newLang);
    localStorage.setItem("language", newLang);
  }, [i18n]);

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <header className="sticky top-0 z-50 border-b border-gray-800 bg-[#0d1117]/95 backdrop-blur-sm pb-4">
        <div className="max-w-xl mx-auto px-6 h-20 flex items-end justify-between pb-4">
          <span className="font-extrabold text-lg tracking-tight text-white">{t("header.title")}</span>
          <div className="flex items-center gap-2">
            <WalletConnect />
            <button 
              onClick={toggleLanguage}
              className="text-sm border border-gray-700 rounded-lg px-3 py-1.5 text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150"
            >
              {i18n.language === "en" ? "FR" : "EN"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-6 py-10">
        <VaultPanel />
      </main>
    </div>
  );
}

export default function App() {
  // Evict a stale persisted wallet if Freighter is no longer available.
  useEffect(() => {
    void useWalletStore.getState().revalidate();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
      <Toasts />
    </QueryClientProvider>
  );
}
