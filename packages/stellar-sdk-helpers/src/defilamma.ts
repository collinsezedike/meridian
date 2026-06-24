import { withRetry } from "@meridian/shared";

export interface DefiLlamaPool {
  pool: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyPct1D: number | null;
  apyPct7D: number | null;
  apyPct30D: number | null;
  poolMeta: string | null;
  stablecoin: boolean;
  chain: string;
}

export type RiskLevel = "safe" | "caution" | "risky";

/**
 * Score-based heuristic — three independent signals, each additive:
 *   TVL depth  : low liquidity = harder to exit
 *   APY swing  : high 7-day volatility = rate instability
 *   APY ceiling: stablecoin yield >12 % is suspicious
 *
 * score 0-1 → safe | 2-3 → caution | 4+ → risky
 */
export function assessPoolRisk(pool: DefiLlamaPool): RiskLevel {
  let score = 0;

  if (pool.tvlUsd < 10_000)           score += 3;
  else if (pool.tvlUsd < 100_000)     score += 2;
  else if (pool.tvlUsd < 2_000_000)   score += 1;

  const vol7d = Math.abs(pool.apyPct7D ?? 0);
  if (vol7d > 30)     score += 3;
  else if (vol7d > 5) score += 2;
  else if (vol7d > 1) score += 1;

  if (pool.apy > 20)      score += 2;
  else if (pool.apy > 12) score += 1;

  if (score >= 4) return "risky";
  if (score >= 2) return "caution";
  return "safe";
}

const POOLS_URL = "https://yields.llama.fi/pools";
const MIN_TVL_USD = 1_000;
const MIN_APY = 0.01;

/**
 * Fetch all Stellar stablecoin pools from DeFiLlama and return the ones that
 * meet the minimum TVL and APY thresholds. Retries up to 3 times on failure.
 */
export async function getStellarStablecoinPools(): Promise<DefiLlamaPool[]> {
  return withRetry(async () => {
    const res = await fetch(POOLS_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`DeFiLlama /pools HTTP ${res.status}`);
    const json = (await res.json()) as { data: DefiLlamaPool[] };
    return json.data.filter(
      (p) => p.chain === "Stellar" && p.stablecoin && p.apy >= MIN_APY && p.tvlUsd >= MIN_TVL_USD
    );
  });
}
