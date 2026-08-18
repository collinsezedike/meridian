import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  loadBlendAccrualKeeperConfig,
  runBlendAccrualKeeper,
} from "@meridian/stellar-sdk-helpers";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

function authorizationHeader(req: VercelRequest): string | undefined {
  const raw = req.headers.authorization;
  return Array.isArray(raw) ? raw[0] : raw;
}

function isCronAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return authorizationHeader(req) === `Bearer ${secret}`;
}

function missingCronSecretContext(): Record<string, string> {
  return { vercelEnv: process.env.VERCEL_ENV ?? "local" };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!(await checkRateLimit(req, res))) return;

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.CRON_SECRET) {
    console.error(
      "[accrual-keeper] CRON_SECRET is not configured",
      missingCronSecretContext()
    );
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
