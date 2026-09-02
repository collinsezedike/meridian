import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetVaults } from "@meridian/api-core";
import { APP_NETWORK } from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

// Cache the aggregated vault list at the Vercel CDN. APY/TVL move slowly on
// mainnet, so a short fresh window keeps DeFiLlama call volume low, and the
// stale-while-revalidate window lets the edge keep serving the last good
// payload through a transient DeFiLlama outage instead of failing the whole
// dashboard. Testnet reads go straight to the chain on every call (see
// fetchAllVaults) specifically so deposits/withdrawals show up immediately
// during testing; caching the HTTP response on top of that would defeat the
// purpose, so testnet gets no-store instead.
const MAINNET_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";
const TESTNET_CACHE_CONTROL = "no-store";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[vaults] rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }

  const result = await handleGetVaults();
  if (result.error) {
    console.error("[vaults] fetch error:", result.error);
  }
  if (result.status === 200) {
    res.setHeader(
      "Cache-Control",
      APP_NETWORK.network === "testnet"
        ? TESTNET_CACHE_CONTROL
        : MAINNET_CACHE_CONTROL
    );
  }
  res.status(result.status).json(result.body);
}
