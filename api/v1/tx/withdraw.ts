import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleWithdrawRequest } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!(await checkRateLimit(req, res, { strict: true }))) return;
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const result = await handleWithdrawRequest(req.body);
  if (result.error) {
    const cause = (result.error as { cause?: unknown } | undefined)?.cause;
    console.error(
      "[tx/withdraw] build failed:",
      result.error,
      cause ? { cause } : ""
    );
  }
  res.status(result.status).json(result.body);
}
