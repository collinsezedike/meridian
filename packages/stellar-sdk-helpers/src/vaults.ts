import { getStellarStablecoinPools, assessPoolRisk, type RiskLevel } from "./defilamma";
import { KNOWN_POOLS } from "./known-pools";

export interface ApiVault {
  id: string;
  protocol: "blend" | "defindex";
  asset: string;
  name: string;
  label: string;
  apy: number;
  tvl: number;
  userBalance: number;
  riskLevel: RiskLevel;
}

// TTL matches the CDN s-maxage on the vaults endpoint (60 s). Both the Fastify
// server (long-lived process) and warm Vercel invocations benefit from this
// without adding any external dependency.
const CACHE_TTL_MS = 60_000;
let vaultCache: { vaults: ApiVault[]; expiresAt: number } | null = null;

/** Clears the in-memory vault cache. Exposed for tests only. */
export function clearVaultCache(): void {
  vaultCache = null;
}

/** Returns true if a valid cached result exists and will be returned by fetchAllVaults. */
export function isVaultCacheWarm(): boolean {
  return vaultCache !== null && Date.now() < vaultCache.expiresAt;
}

/**
 * Fetch vaults from DeFiLlama and return those backed by known on-chain pools.
 * Results are cached for 60 s. If DeFiLlama returns no usable pools, the
 * previous cache is served rather than returning an empty list.
 */
export async function fetchAllVaults(): Promise<ApiVault[]> {
  const now = Date.now();
  if (vaultCache && now < vaultCache.expiresAt) return vaultCache.vaults;

  const pools = await getStellarStablecoinPools();

  const vaults: ApiVault[] = [];
  for (const pool of pools) {
    const meta = KNOWN_POOLS[pool.pool];
    if (!meta) {
      console.warn("[vaults] unknown DeFiLlama pool, skipping:", pool.pool, pool.project, pool.symbol);
      continue;
    }
    vaults.push({
      ...meta,
      asset: pool.symbol,
      apy: Number(pool.apy.toFixed(2)),
      tvl: Math.round(pool.tvlUsd),
      userBalance: 0,
      riskLevel: assessPoolRisk(pool),
    });
  }

  if (vaults.length > 0) {
    vaultCache = { vaults, expiresAt: now + CACHE_TTL_MS };
    return vaults;
  }

  // DeFiLlama returned no usable pools — likely a transient blip.
  // Serve the previous cache if still populated so the dashboard stays live;
  // otherwise return empty and let callers decide how to handle it.
  return vaultCache?.vaults ?? [];
}
