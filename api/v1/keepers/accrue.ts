import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  loadBlendAccrualKeeperConfig,
  runBlendAccrualKeeper,
} from "@meridian/stellar-sdk-helpers";

function authorizationHeader(req: VercelRequest): string | undefined {
  const raw = req.headers.authorization;
  return Array.isArray(raw) ? raw[0] : raw;
}

// Constant-time comparison: this endpoint authorizes real signed
// transactions, so the bearer token check shouldn't leak timing
// information a network attacker could use to guess CRON_SECRET
// character-by-character.
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isCronAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // Permissive only for true local dev (no VERCEL_ENV at all). Preview
  // deployments have their own public URL and, unlike simple rate-limit
  // relaxation elsewhere, this endpoint triggers real signed transactions
  // off the keeper's funded account, so an unauthenticated preview caller
  // could drain its balance by spamming the endpoint. Preview and
  // production both require CRON_SECRET.
  if (!secret) return process.env.VERCEL_ENV === undefined;
  return safeCompare(authorizationHeader(req) ?? "", `Bearer ${secret}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.CRON_SECRET && process.env.VERCEL_ENV !== undefined) {
    return res.status(503).json({ error: "CRON_SECRET is not configured" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const config = loadBlendAccrualKeeperConfig(process.env);
    const result = await runBlendAccrualKeeper(config);
    const status = result.failures.length > 0 ? 500 : 200;
    return res.status(status).json(result);
  } catch (err) {
    console.error("[accrual-keeper] run failed:", err);
    const message = err instanceof Error ? err.message : "Keeper failed";
    return res.status(500).json({ error: message });
  }
}
