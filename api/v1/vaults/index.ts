import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchAllVaults,
  selectBestVault,
  isVaultCacheWarm,
} from "@meridian/stellar-sdk-helpers";
import { isDefindexConfigured, APP_NETWORK } from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

// Cache the aggregated vault list at the Vercel CDN. APY/TVL move slowly, so a
// short fresh window keeps DeFiLlama call volume low, and the stale-while-
// revalidate window lets the edge keep serving the last good payload through a
// transient DeFiLlama outage instead of failing the whole dashboard.
const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!checkRateLimit(req, res)) return;
  try {
    const cached = isVaultCacheWarm();
    const vaults = await fetchAllVaults(APP_NETWORK.network);
    const best = selectBestVault(vaults, {
      defindexConfigured: isDefindexConfigured(),
    });
    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.json({
      vaults,
      recommendedVaultId: best?.id ?? null,
      updatedAt: new Date().toISOString(),
      cached,
    });
  } catch (err) {
    console.error("[vaults] fetch error:", err);
    res.status(500).json({ error: "Failed to fetch vaults" });
  }
}
