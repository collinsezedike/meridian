const API_BASE = import.meta.env.VITE_API_URL ?? "";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    let msg = res.statusText;
    if (body !== null && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.error === "string") {
        msg = b.error;
      } else if (typeof b.error === "object" && b.error !== null) {
        const errObj = b.error as Record<string, unknown>;
        if (typeof errObj.message === "string") {
          msg = errObj.message;
        }
      } else if (typeof b.message === "string") {
        msg = b.message;
      }
    }
    msg = msg || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// JSON-safe vault shape (bigints serialised as numbers by the API)
export interface ApiVault {
  id: string;
  protocol: "blend" | "defindex";
  asset: string;
  name: string;
  label: string;
  apy: number;
  tvl: number;
  userBalance: number;
  riskLevel: "safe" | "caution" | "risky";
}

export interface ApiPosition {
  vaultId: string;
  shares: number;
  deposited: number;
  earned: number;
  entryTime: number;
}

export const api = {
  getVaults: () =>
    apiFetch<{
      vaults: ApiVault[];
      recommendedVaultId: string | null;
      updatedAt: string;
      cached: boolean;
    }>("/api/v1/vaults"),
  getPositions: (publicKey: string) =>
    apiFetch<{ positions: ApiPosition[] }>(
      `/api/v1/positions/${publicKey}`
    ),
  addTrustline: (walletAddress: string) =>
    apiFetch<{ xdr: string }>("/api/v1/tx/add-trustline", {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    }),
  buildDeposit: (body: { walletAddress: string; vaultId: string; amount: string }) =>
    apiFetch<{ xdr: string; fee: string }>("/api/v1/tx/deposit", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  buildWithdraw: (body: { walletAddress: string; vaultId: string; shares: string }) =>
    apiFetch<{ xdr: string; fee: string }>("/api/v1/tx/withdraw", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  submitTx: (body: { xdr: string }) =>
    apiFetch<{ hash: string }>("/api/v1/tx/submit", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
