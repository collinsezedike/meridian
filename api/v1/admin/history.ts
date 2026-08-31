import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetAdminHistory } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

const CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=120";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!(await checkRateLimit(req, res))) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const raw = req.query["vaultId"];
  const vaultId = typeof raw === "string" ? raw : undefined;
  if (!vaultId) return res.status(400).json({ error: "vaultId is required" });

  const result = await handleGetAdminHistory(vaultId);
  if (result.status === 200) {
    res.setHeader("Cache-Control", CACHE_CONTROL);
  }
  res.status(result.status).json(result.body);
}
