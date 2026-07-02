import type { VercelRequest, VercelResponse } from "@vercel/node";
import { submitTx } from "@meridian/stellar-sdk-helpers";
import {
  APP_NETWORK,
  SubmitRequestSchema,
  formatZodError,
  sanitizeTxError,
} from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!checkRateLimit(req, res)) return;
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const parsed = SubmitRequestSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: formatZodError(parsed.error) });

  try {
    const result = await submitTx(parsed.data.xdr, APP_NETWORK);
    res.json(result);
  } catch (err) {
    console.error("[tx/submit] failed:", err);
    res
      .status(500)
      .json({ error: sanitizeTxError(err, "Failed to submit transaction") });
  }
}
