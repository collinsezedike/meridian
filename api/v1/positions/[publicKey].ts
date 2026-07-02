import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolvePositions } from "@meridian/stellar-sdk-helpers";
import {
  APP_NETWORK,
  buildTxAddresses,
  isValidStellarAddress,
} from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!checkRateLimit(req, res)) return;
  const { publicKey } = req.query as { publicKey: string };

  if (!publicKey || !isValidStellarAddress(publicKey)) {
    return res.status(400).json({ error: "Invalid public key" });
  }

  try {
    const positions = await resolvePositions(
      publicKey,
      APP_NETWORK,
      buildTxAddresses(process.env.DEFINDEX_VAULT_ID)
    );
    res.json({ positions });
  } catch (err) {
    console.error("[positions] error:", err);
    res.status(503).json({ error: "Failed to read positions" });
  }
}
