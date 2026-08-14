import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  loadBlendAccrualKeeperConfig,
  runBlendAccrualKeeper,
} from "@meridian/stellar-sdk-helpers";
import { checkRateLimit } from "../../_lib/middleware.js";

function authorizationHeader(req: VercelRequest): string | undefined {
  const raw = req.headers.authorization;
  return Array.isArray(raw) ? raw[0] : raw;
}

// Constant-time comparison: this endpoint authorizes real signed
// transactions, so the bearer token check shouldn't leak timing
// information a network attacker could use to guess CRON_SECRET
// character-by-character. Both inputs are hashed to a fixed 32-byte digest
// first, so there's no length-based short-circuit before timingSafeEqual,
// a naive length check up front would itself leak the secret's length via
// timing before the constant-time comparison ever ran.
function safeCompare(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
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

  // No applyCors: this endpoint is cron-invoked, never browser-facing. But
  // it does sign and submit real transactions off the keeper's funded
  // account, unlike simple reads, so it still gets a rate-limit backstop:
  // defense-in-depth if CRON_SECRET ever leaks or a non-production instance
  // is reachable, even though the legitimate cron caller is nowhere near
  // this limit at one call per 15 minutes.
  if (!(await checkRateLimit(req, res))) return;

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
