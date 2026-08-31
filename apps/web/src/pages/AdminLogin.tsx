import { useEffect, useState } from "react";
import { fetchVaultAdmin } from "@meridian/stellar-sdk-helpers";
import { APP_ADDRESSES, APP_NETWORK } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { useWalletConnect } from "../hooks/useWalletConnect";
import { AdminDashboard } from "./AdminDashboard";

// Keyed by the public key it was resolved for, so a wallet switch is
// recognized as "not checked yet" (loading) during render rather than
// needing an effect to reset it back to loading first.
interface GateResult {
  publicKey: string;
  authorized: boolean;
}

export function AdminLogin() {
  const { publicKey, connected } = useWalletStore();
  const { handleConnect, status: connectStatus } = useWalletConnect();
  const [result, setResult] = useState<GateResult | null>(null);

  useEffect(() => {
    if (!connected || !publicKey) return;
    let cancelled = false;
    fetchVaultAdmin({ contractId: APP_ADDRESSES.vault, network: APP_NETWORK })
      .then((admin) => {
        if (!cancelled) {
          setResult({ publicKey, authorized: admin === publicKey });
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ publicKey, authorized: false });
      });
    return () => {
      cancelled = true;
    };
  }, [connected, publicKey]);

  const status: "loading" | "blocked" | "allowed" =
    result?.publicKey !== publicKey
      ? "loading"
      : result.authorized
        ? "allowed"
        : "blocked";

  if (!connected) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0d1117]">
        <button
          onClick={() => void handleConnect()}
          disabled={connectStatus === "connecting"}
          className="px-6 py-3 bg-emerald-500 text-white rounded-lg disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0d1117]">
        <div className="rounded-xl border border-gray-800 bg-[#161b22] px-6 py-4 text-red-400 text-sm">
          Not authorized: {publicKey}
        </div>
      </div>
    );
  }

  if (status === "allowed") {
    return (
      <div className="min-h-screen bg-[#0d1117] text-white">
        <AdminDashboard />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#0d1117] text-gray-400">
      Loading...
    </div>
  );
}
