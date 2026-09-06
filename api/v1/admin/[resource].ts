import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetAdminHistory, handleGetVaultState } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

const HISTORY_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=120";

// Consolidated from two separate files (history/vault-state) to stay under
// Vercel's per-deployment Serverless Functions cap. URL paths are
// unchanged: /api/v1/admin/history and /api/v1/admin/vault-state both
// route here via the [resource].ts dynamic segment, with
// req.query.resource set accordingly. Both are public read-only endpoints
// (same data as the public /api/v1/vaults and /api/v1/positions routes,
// just reshaped for the admin dashboard), so they share one auth model.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!(await checkRateLimit(req, res))) return;

  const { resource } = req.query;

  if (resource === "vault-state") {
    const result = await handleGetVaultState();
    if (result.error) console.error("[admin/vault-state] error:", result.error);
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  }

  if (resource === "history") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const raw = req.query["vaultId"];
    const vaultId = typeof raw === "string" ? raw : undefined;
    if (!vaultId) return res.status(400).json({ error: "vaultId is required" });

    const result = await handleGetAdminHistory(vaultId);
    if (result.status === 200) {
      res.setHeader("Cache-Control", HISTORY_CACHE_CONTROL);
    }
    return res.status(result.status).json(result.body);
  }

  return res.status(404).json({ error: "Unknown resource" });
}
