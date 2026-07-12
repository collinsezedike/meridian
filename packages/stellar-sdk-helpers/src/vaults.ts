import { PoolV2 } from "@blend-capital/blend-sdk";
import {
  getStellarStablecoinPools,
  assessPoolRisk,
  type RiskLevel,
} from "./defilamma";
import { KNOWN_POOLS } from "./known-pools";
import { APP_NETWORK, withRaceTimeout } from "@meridian/shared";
import { simulateView } from "./tx";
import { getRpcServer, toBigInt } from "./internal";

export interface ApiVault {
  id: string;
  protocol: "blend" | "defindex" | "meridian";
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
 * Reads the live supply APY for the Blend pool at `poolId`, matching the
 * reserve for `assetId`. Returns 0 if the pool has no such reserve.
 */
async function fetchBlendApy(
  network: { rpc: string; passphrase: string },
  poolId: string,
  assetId: string
): Promise<number> {
  const pool = await withRaceTimeout(
    () => PoolV2.load(network, poolId),
    10_000,
    "Blend RPC"
  );
  const reserve = pool.reserves.get(assetId);
  return reserve ? Number((reserve.estSupplyApy * 100).toFixed(2)) : 0;
}

/**
 * Discovers the live APY for a Meridian coordinator vault by reading its
 * active adapter's underlying protocol on-chain (get_adapter -> get_pool /
 * get_protocol) rather than tracking it in config. This makes rate discovery
 * self-updating if the adapter is ever swapped via `set_adapter`: there is no
 * config entry that could drift out of sync with the actual deployment.
 *
 * DeFindex has no live-rate SDK integration wired up yet, so vaults backed by
 * a DefindexAdapter report apy: 0 until that is added. Any adapter protocol
 * this function doesn't recognise also reports apy: 0 rather than throwing,
 * so a future protocol degrades gracefully (TVL is unaffected) until its
 * rate-fetching branch is added here.
 */
async function fetchMeridianApy(
  server: ReturnType<typeof getRpcServer>,
  network: { rpc: string; passphrase: string },
  vaultId: string,
  assetId: string
): Promise<number> {
  const adapterId = (await simulateView(
    server,
    vaultId,
    network.passphrase,
    "get_adapter"
  )) as string;

  const [poolId, protocol] = (await Promise.all([
    simulateView(server, adapterId, network.passphrase, "get_pool"),
    simulateView(server, adapterId, network.passphrase, "get_protocol"),
  ])) as [string, string];

  if (protocol === "blend") {
    return fetchBlendApy(network, poolId, assetId);
  }

  return 0;
}

/**
 * Query each pool in KNOWN_POOLS.testnet on-chain and return its TVL and APY.
 * Blend pools use PoolV2.load directly; Meridian coordinator vaults read
 * get_total_assets for TVL and discover their active adapter's protocol
 * on-chain for APY (see fetchMeridianApy). Adding a new testnet pool only
 * requires a new entry in KNOWN_POOLS.testnet.
 */
async function fetchTestnetVaults(): Promise<ApiVault[]> {
  const network = {
    rpc: APP_NETWORK.rpcUrl,
    passphrase: APP_NETWORK.passphrase,
  };
  const vaults: ApiVault[] = [];

  for (const meta of Object.values(KNOWN_POOLS.testnet)) {
    if (meta.protocol === "blend") {
      const pool = await withRaceTimeout(
        () => PoolV2.load(network, meta.contractId),
        10_000,
        "Blend RPC"
      );
      const reserve = pool.reserves.get(meta.assetId);
      const tvl = reserve ? Math.round(Number(reserve.totalSupply()) / 1e7) : 0;
      const apy = reserve ? Number((reserve.estSupplyApy * 100).toFixed(2)) : 0;
      vaults.push({ ...meta, apy, tvl, userBalance: 0, riskLevel: "safe" });
    } else if (meta.protocol === "meridian") {
      const server = getRpcServer(network.rpc, 10_000);
      const [totalAssetsRaw, apy] = await Promise.all([
        withRaceTimeout(
          () =>
            simulateView(
              server,
              meta.contractId,
              network.passphrase,
              "get_total_assets"
            ),
          10_000,
          "Meridian RPC"
        ),
        withRaceTimeout(
          () =>
            fetchMeridianApy(server, network, meta.contractId, meta.assetId),
          10_000,
          "Meridian adapter RPC"
        ),
      ]);
      const tvl = Math.round(Number(toBigInt(totalAssetsRaw)) / 1e7);
      vaults.push({ ...meta, apy, tvl, userBalance: 0, riskLevel: "safe" });
    }
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
