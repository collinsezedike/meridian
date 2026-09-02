import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  consoleLogger,
  loadBlendAccrualKeeperConfig,
  loadKeeperHeartbeatStore,
  recordKeeperHeartbeat,
  redactedErrorMessage,
  runBlendAccrualKeeper,
} from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK } from "@meridian/shared";
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
  // it does sign and submit real transactions off the keeper's funded
  // account, unlike simple reads, so it still gets a rate-limit backstop.
  // Checked before auth, deliberately, even though that costs a Redis round
  // trip on an unauthenticated probe: this is the volume-abuse backstop for
  // *all* traffic, not just correctly-authenticated traffic, if it only ran
  // after a successful auth check, unauthenticated/wrong-token spam would
  // be entirely unbounded, since a 401 would return before this ever runs.
  // Wrapped, unlike a plain `await`: checkRateLimit talks to Upstash, and an
  // outage there would otherwise escape as a bare unhandled 500 with no
  // [accrual-keeper] log line, before the run (and its own store-outage
  // signalling) ever starts. Fails closed on purpose even though the run
  // itself is more tolerant: this is the abuse backstop on an endpoint that
  // signs real transactions, and the next scheduled tick retries anyway.
  try {
    if (!(await checkRateLimit(req, res, { strict: true }))) return;
  } catch (err) {
    console.error("[accrual-keeper] rate limit check failed:", err);
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
    const config = loadBlendAccrualKeeperConfig(process.env);
    const result = await runBlendAccrualKeeper(config);
    const status = result.failures.length > 0 ? 500 : 200;
    // Recorded on a clean run only (no failures), even if there was nothing
    // to do (zero discovered adapters): a clean no-op run still proves the
    // keeper itself is alive, which is what the admin dashboard's Keeper
    // Health card is showing. Best-effort and after the response status is
    // already decided — a heartbeat-store hiccup must never turn an
    // otherwise-successful run into a reported failure.
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
