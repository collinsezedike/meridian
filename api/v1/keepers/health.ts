import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetKeeperHealth } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

// Read-only: reports on keeper runs already recorded elsewhere (see
// keeper-heartbeat.ts), never triggers one. No cron auth needed — unlike
// accrue.ts/rebalance.ts this signs nothing and holds no funded-account
// authority, so it's public the same way /api/v1/vaults is.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!(await checkRateLimit(req, res))) return;

  const result = await handleGetKeeperHealth();
  if (result.error) {
    console.error("[keepers/health] error:", result.error);
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(result.status).json(result.body);
}
