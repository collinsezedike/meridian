import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  consoleLogger,
  isMigrationKeeperConfigured,
  loadBlendAccrualKeeperConfig,
  loadKeeperHeartbeatStore,
  loadMigrationKeeperConfig,
  recordKeeperHeartbeat,
  redactedErrorMessage,
  runBlendAccrualKeeper,
  runMigrationKeeper,
} from "@meridian/stellar-sdk-helpers";
import { handleGetKeeperHealth } from "@meridian/api-core";
import { APP_NETWORK } from "@meridian/shared";
import {
  applyCors,
  checkRateLimit,
  isCronAuthorized,
  isCronSecretConfigured,
} from "../../_lib/middleware.js";

// Consolidated from three separate files (accrue/health/rebalance) to stay
// under Vercel's per-deployment Serverless Functions cap. URL paths are
// unchanged: /api/v1/keepers/accrue, /api/v1/keepers/health, and
// /api/v1/keepers/rebalance all route here via the [action].ts dynamic
// segment, with req.query.action set accordingly.
//
// health is read-only and public, same as before; accrue/rebalance still
// require the cron bearer token and are never CORS-gated, since they sign
// and submit real transactions off a funded/admin account. That auth split
// is preserved exactly as it was when these were separate files.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { action } = req.query;

  if (action === "health") {
    if (applyCors(req, res)) return;
    if (!(await checkRateLimit(req, res))) return;
    const result = await handleGetKeeperHealth();
    if (result.error) console.error("[keepers/health] error:", result.error);
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  }

  if (action !== "accrue" && action !== "rebalance") {
    return res.status(404).json({ error: "Unknown action" });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // No applyCors: cron-invoked, never browser-facing. But both sign and
  // submit real transactions, unlike simple reads, so they still get a
  // rate-limit backstop. Checked before auth, deliberately, even though
  // that costs a Redis round trip on an unauthenticated probe: this is the
  // volume-abuse backstop for *all* traffic, not just correctly
  // authenticated traffic — if it only ran after a successful auth check,
  // unauthenticated/wrong-token spam would be entirely unbounded.
  try {
    if (!(await checkRateLimit(req, res, { strict: true }))) return;
  } catch (err) {
    console.error(`[keepers/${action}] rate limit check failed:`, err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }

  if (!isCronSecretConfigured()) {
    return res.status(503).json({ error: "CRON_SECRET is not configured" });
  }
  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (action === "accrue") {
    try {
      const config = loadBlendAccrualKeeperConfig(process.env);
      const result = await runBlendAccrualKeeper(config);
      const status = result.failures.length > 0 ? 500 : 200;
      if (result.failures.length === 0) {
        const store = loadKeeperHeartbeatStore(process.env, {
          logger: consoleLogger,
        });
        await recordKeeperHeartbeat(
          store,
          "accrual",
          APP_NETWORK.network,
          consoleLogger
        );
      }
      return res.status(status).json(result);
    } catch (err) {
      console.error("[accrual-keeper] run failed:", err);
      return res.status(500).json({ error: redactedErrorMessage(err) });
    }
  }

  // The migration keeper is deliberately not fully wired up yet (#511,
  // #514): ops may reasonably leave this unset until both land. Without
  // this check, every hourly cron tick would throw inside
  // loadMigrationKeeperConfig and report a 500, a permanent, noisy false
  // alarm for an intentionally disabled feature, not an actual failure.
  if (!isMigrationKeeperConfigured(process.env)) {
    return res.status(200).json({
      status: "disabled",
      message: "MERIDIAN_MIGRATION_KEEPER_SECRET_KEY is not configured",
    });
  }

  try {
    const config = loadMigrationKeeperConfig(process.env);
    const result = await runMigrationKeeper(config);
    const status = result.failures.length > 0 ? 500 : 200;
    if (result.failures.length === 0) {
      const store = loadKeeperHeartbeatStore(process.env, {
        logger: consoleLogger,
      });
      await recordKeeperHeartbeat(
        store,
        "migration",
        APP_NETWORK.network,
        consoleLogger
      );
    }
    return res.status(status).json(result);
  } catch (err) {
    console.error("[migration-keeper] run failed:", err);
    return res.status(500).json({ error: redactedErrorMessage(err) });
  }
}
