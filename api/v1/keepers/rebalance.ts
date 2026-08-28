import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isMigrationKeeperConfigured,
  loadMigrationKeeperConfig,
  redactedErrorMessage,
  runMigrationKeeper,
} from "@meridian/stellar-sdk-helpers";
import {
  checkRateLimit,
  isCronAuthorized,
  isCronSecretConfigured,
} from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // No applyCors: this endpoint is cron-invoked, never browser-facing. But
  // it does sign and submit real migrate_adapter transactions off the
  // vault's admin key, unlike simple reads, so it still gets a rate-limit
  // backstop. Checked before auth, deliberately, even though that costs a
  // Redis round trip on an unauthenticated probe: this is the volume-abuse
  // backstop for *all* traffic, not just correctly-authenticated traffic;
  // if it only ran after a successful auth check, unauthenticated/wrong-token
  // spam would be entirely unbounded against an endpoint holding full vault
  // admin authority.
  // Wrapped, unlike a plain `await`: checkRateLimit talks to Upstash, and an
  // outage there would otherwise escape as a bare unhandled 500 with no
  // [migration-keeper] log line, before the run (and its own store-outage
  // signalling) ever starts. Fails closed on purpose even though the run
  // itself is more tolerant: this is the abuse backstop on an endpoint that
  // signs real transactions, and the next scheduled tick retries anyway.
  try {
    if (!(await checkRateLimit(req, res, { strict: true }))) return;
  } catch (err) {
    console.error("[migration-keeper] rate limit check failed:", err);
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

  // The migration keeper is deliberately not fully wired up yet (#511, #514):
  // ops may reasonably leave this unset until both land. Without this check,
  // every hourly cron tick would throw inside loadMigrationKeeperConfig and
  // report a 500, a permanent, noisy false alarm for an intentionally
  // disabled feature, not an actual failure.
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
    return res.status(status).json(result);
  } catch (err) {
    console.error("[migration-keeper] run failed:", err);
    return res.status(500).json({ error: redactedErrorMessage(err) });
  }
}
