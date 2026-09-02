import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetVaultState } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

// Read-only vault state (adapter/protocol, total shares, total assets,
// paused) for the admin dashboard's Vault State card. Public the same way
// /api/v1/vaults is: nothing here is sensitive, it's the same on-chain data
// that page already shows, just reshaped for the admin view.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!(await checkRateLimit(req, res))) return;

  const result = await handleGetVaultState();
  if (result.error) {
    console.error("[admin/vault-state] error:", result.error);
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(result.status).json(result.body);
}
