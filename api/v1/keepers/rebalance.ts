import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  loadMigrationKeeperConfig,
  runMigrationKeeper,
} from "@meridian/stellar-sdk-helpers";
import { checkRateLimit, isCronAuthorized } from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // No applyCors: this endpoint is cron-invoked, never browser-facing. But
  // it does sign and submit real migrate_adapter transactions off the
  // vault's admin key, unlike simple reads, so it still gets a rate-limit
  // backstop: defense-in-depth if CRON_SECRET ever leaks or a
  // non-production instance is reachable, even though the legitimate cron
  // caller is nowhere near this limit at one call per interval.
  if (!(await checkRateLimit(req, res))) return;

  if (!process.env.CRON_SECRET && process.env.VERCEL_ENV !== undefined) {
    return res.status(503).json({ error: "CRON_SECRET is not configured" });
  }

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // The migration keeper is deliberately not fully wired up yet (#511, #514):
  // ops may reasonably leave this unset until both land. Without this check,
  // every hourly cron tick would throw inside loadMigrationKeeperConfig and
  // report a 500, a permanent, noisy false alarm for an intentionally
  // disabled feature, not an actual failure.
  if (!process.env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY?.trim()) {
    return res.status(200).json({
      status: "disabled",
      message: "MERIDIAN_MIGRATION_KEEPER_SECRET_KEY is not configured",
    });
  }

  try {
    const config = loadMigrationKeeperConfig(process.env);
    const result = await runMigrationKeeper(config);
    const status = result.failures.length > 0 ? 500 : 200;
    return res.status(status).json(result);
  } catch (err) {
    console.error("[migration-keeper] run failed:", err);
    const message = err instanceof Error ? err.message : "Keeper failed";
    return res.status(500).json({ error: message });
  }
}
