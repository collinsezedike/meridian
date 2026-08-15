import type { VercelRequest, VercelResponse } from "@vercel/node";
import { KNOWN_POOLS } from "@meridian/stellar-sdk-helpers";
import { handleGetVaultById } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";
const KNOWN_VAULT_IDS = new Set(
  [
    ...Object.values(KNOWN_POOLS.mainnet),
    ...Object.values(KNOWN_POOLS.testnet),
  ].map((p) => p.id)
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!(await checkRateLimit(req, res))) return;
  const raw = req.query["vaultId"];
  const vaultId = typeof raw === "string" ? raw : undefined;
  if (!vaultId) return res.status(400).json({ error: "vaultId is required" });
  if (!KNOWN_VAULT_IDS.has(vaultId))
    return res.status(404).json({ error: "vault not found", vaultId });

  const result = await handleGetVaultById(vaultId);
  if (result.error) {
    console.error("[vaults] fetch error:", result.error);
  }
  if (result.status === 200) {
    res.setHeader("Cache-Control", CACHE_CONTROL);
  }
  res.status(result.status).json(result.body);
}
