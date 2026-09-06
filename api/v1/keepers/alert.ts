import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  consoleLogger,
  loadAlertKeeperConfig,
  loadKeeperHeartbeatStore,
  redactedErrorMessage,
  runAlertKeeper,
} from "@meridian/stellar-sdk-helpers";
import {
  checkRateLimit,
  isCronAuthorized,
  isCronSecretConfigured,
} from "../../_lib/middleware.js";

// Cron-invoked, same as accrue.ts/rebalance.ts, but unlike either of those
// this endpoint signs and submits nothing — it only reads events and posts
// to a webhook. Rate-limited anyway: an unauthenticated probe hammering
// this route still costs an RPC round trip per known vault plus a webhook
// POST, and checked before auth for the same reason accrue.ts does — a 401
// short-circuit would leave the volume-abuse backstop covering only
// correctly-authenticated traffic.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!(await checkRateLimit(req, res, { strict: true }))) return;
  } catch (err) {
    console.error("[alert-keeper] rate limit check failed:", err);
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

  try {
    const config = loadAlertKeeperConfig(process.env);
    // Without a shared cursor store, a restart or a second concurrent
    // invocation has no memory of what it already alerted on, reinstating
    // exactly the replay this keeper exists to prevent. Reuses
    // keeper-heartbeat.ts's generic numeric store rather than requiring a
    // dedicated cursor store.
    const cursorStore = loadKeeperHeartbeatStore(process.env, {
      logger: consoleLogger,
    });
    const result = await runAlertKeeper(config, { cursorStore });
    const status = result.failures.length > 0 ? 500 : 200;
    return res.status(status).json(result);
  } catch (err) {
    console.error("[alert-keeper] run failed:", err);
    return res.status(500).json({ error: redactedErrorMessage(err) });
  }
}
