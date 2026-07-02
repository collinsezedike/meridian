import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildDepositTx } from "@meridian/stellar-sdk-helpers";
import {
  APP_NETWORK,
  buildTxAddresses,
  DepositRequestSchema,
  formatZodError,
  sanitizeTxError,
} from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!checkRateLimit(req, res)) return;
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const parsed = DepositRequestSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: formatZodError(parsed.error) });

  try {
    const { walletAddress, vaultId, amount } = parsed.data;
    const result = await buildDepositTx(
      vaultId,
      walletAddress,
      amount,
      buildTxAddresses(process.env.DEFINDEX_VAULT_ID),
      APP_NETWORK
    );
    return res.json(result);
  } catch (err) {
    console.error("[tx/deposit] build failed:", err);
    res.status(500).json({
      error: sanitizeTxError(err, "Failed to build deposit transaction"),
    });
  }
}
