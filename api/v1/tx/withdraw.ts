import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildWithdrawTx } from "@meridian/stellar-sdk-helpers";
import {
  APP_NETWORK,
  WithdrawRequestSchema,
  formatZodError,
  sanitizeTxError,
} from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!(await checkRateLimit(req, res))) return;
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const parsed = WithdrawRequestSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: formatZodError(parsed.error) });

  try {
    const { walletAddress, vaultId, shares } = parsed.data;
    const result = await buildWithdrawTx(
      vaultId,
      walletAddress,
      shares,
      APP_NETWORK
    );
    return res.json(result);
  } catch (err) {
    const cause = (err as { cause?: unknown } | undefined)?.cause;
    console.error("[tx/withdraw] build failed:", err, cause ? { cause } : "");
    res.status(500).json({
      error: sanitizeTxError(err, "Failed to build withdraw transaction"),
    });
  }
}
