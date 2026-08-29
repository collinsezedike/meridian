import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleAddTrustlineRequest } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res, { strict: true }))) return;
  } catch (err) {
    console.error("[tx/add-trustline] rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const result = await handleAddTrustlineRequest(req.body);
  if (result.error) {
    console.error("[tx/add-trustline] build failed:", result.error);
  }
  res.status(result.status).json(result.body);
}
