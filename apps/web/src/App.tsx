import { useCallback, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultPanel } from "./components/dashboard/VaultPanel";
import { WalletConnect } from "./components/onboarding/WalletConnect";
import { Toasts } from "./components/ui/Toasts";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { AdminDashboard } from "./pages/AdminDashboard";
import { useWalletStore } from "./store/wallet";
import { useTranslation } from "react-i18next";
import { AdminLogin } from "./pages/AdminLogin";

const queryClient = new QueryClient();

// No router dependency for a single extra route: the app has exactly two
// pages, and pulling in react-router for one static path split would be a
// heavier change than the admin dashboard itself (#615) needs.
//
// The app is served under /app/* (see the root vercel.json rewrite,
// "/app/:path*" -> "/app/index.html"), so the admin route lives at
// /app/admin — that existing rewrite already covers it, no routing config
// change needed.
function isAdminRoute(): boolean {
  return window.location.pathname.startsWith("/app/admin");
}

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
          <span className="font-extrabold text-lg tracking-tight text-white">
            {t("header.title")}
          </span>
          <div className="flex items-center gap-2">
            <WalletConnect />
            <button
              onClick={toggleLanguage}
              className="text-sm border-gray-700 rounded-lg px-3 py-1.5 text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150" // FIX 2: added border
            >
              {i18n.language === "en" ? "FR" : "EN"}
            </button>
          </div>
        </div>
      </header>

      {isAdminRoute() ? (
        <ErrorBoundary>
          <AdminDashboard />
        </ErrorBoundary>
      ) : (
        <main className="max-w-xl mx-auto px-6 py-10">
          <ErrorBoundary>
            <VaultPanel />
          </ErrorBoundary>
        </main>
      )}
    </div>
  );
}

export default function App() {
  useEffect(() => {
    const revalidate = () => void useWalletStore.getState().revalidate();
    revalidate();
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, []);

  const isAdminRoute = window.location.pathname === "/admin";

  return (
    <QueryClientProvider client={queryClient}>
      {isAdminRoute ? <AdminLogin /> : <Dashboard />}
      <Toasts />
    </QueryClientProvider>
  );
}
