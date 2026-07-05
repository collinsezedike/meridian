import { PoolV2 } from "@blend-capital/blend-sdk";
import {
  getStellarStablecoinPools,
  assessPoolRisk,
  type RiskLevel,
} from "./defilamma";
import { KNOWN_POOLS } from "./known-pools";
import { APP_NETWORK, withRaceTimeout } from "@meridian/shared";

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
 * Query each pool in KNOWN_POOLS.testnet on-chain and return its TVL and APY.
 * Both are derived from the Blend SDK's reserve state loaded via PoolV2.load —
 * no external oracle needed. Adding a new testnet pool only requires a new
 * entry in KNOWN_POOLS.testnet.
 */
async function fetchTestnetVaults(): Promise<ApiVault[]> {
  const blendNetwork = {
    rpc: APP_NETWORK.rpcUrl,
    passphrase: APP_NETWORK.passphrase,
  };
  const vaults: ApiVault[] = [];
  for (const meta of Object.values(KNOWN_POOLS.testnet)) {
    const pool = await withRaceTimeout(
      () => PoolV2.load(blendNetwork, meta.poolId),
      10_000,
      "Blend RPC"
    );
    const reserve = pool.reserves.get(meta.assetId);
    // totalSupply() is in stroops (7 decimal places).
    const tvl = reserve ? Math.round(Number(reserve.totalSupply()) / 1e7) : 0;
    // estSupplyApy is a decimal (e.g. 0.05 = 5%); convert to percentage points.
    const apy = reserve ? Number((reserve.estSupplyApy * 100).toFixed(2)) : 0;
    vaults.push({ ...meta, apy, tvl, userBalance: 0, riskLevel: "safe" });
  }
  return vaults;
}

/**
 * Fetch vaults for the given network. On mainnet, pulls live APY/TVL from
 * DeFiLlama and matches against KNOWN_POOLS.mainnet. On testnet, queries the
 * Blend TestnetV2 pool on-chain directly (DeFiLlama does not index testnet).
 * Mainnet results are cached for 60 s; testnet results are always fresh.
 */
export async function fetchAllVaults(
  network: "mainnet" | "testnet" = APP_NETWORK.network
): Promise<ApiVault[]> {
  if (network === "testnet") return fetchTestnetVaults();

  const now = Date.now();
  if (vaultCache && now < vaultCache.expiresAt) return vaultCache.vaults;

  const pools = await getStellarStablecoinPools();

  const vaults: ApiVault[] = [];
  for (const pool of pools) {
    const meta = KNOWN_POOLS.mainnet[pool.pool];
    if (!meta) {
      console.warn(
        "[vaults] unknown DeFiLlama pool, skipping:",
        pool.pool,
        pool.project,
        pool.symbol
      );
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
