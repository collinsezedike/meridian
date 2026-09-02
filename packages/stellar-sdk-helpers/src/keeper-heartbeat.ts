// Last-successful-run tracking for scheduled keepers (#615).
//
// keeper-state.ts's SubmissionLease deliberately *clears* its record the
// moment a transaction's fate is known (see clearRecord there) — it exists
// to dedup in-flight submissions, not to remember history, so "last
// success" is nowhere on disk once a run finishes cleanly. The admin
// dashboard's Keeper Health card needs exactly that history, so this module
// is a second, much simpler store: an unconditional last-write-wins
// timestamp per keeper, with no lease/CAS semantics at all. A heartbeat is a
// monitoring signal, not a correctness guard, so the races SubmissionLease
// guards against (two runs racing to claim the same target) don't apply
// here — the last run to finish is, definitionally, the most recent
// success, whichever one that was.
//
// Reuses the same UPSTASH_REDIS_REST_URL/TOKEN pair as keeper-state.ts and
// api/_lib/middleware.ts rather than adding a new store dependency.

import { withRaceTimeout } from "@meridian/shared";
import { errorMessage, type KeeperLogger } from "./keeper-retry";

// Matches .github/workflows/keepers.yml's cron schedule. Used by the health
// endpoint to decide how overdue a keeper's last success is; kept alongside
// the store (rather than only in the workflow) since both need to agree on
// what "on schedule" means for the same keeper.
export const KEEPER_SCHEDULE_MS: Record<"accrual" | "migration", number> = {
  accrual: 15 * 60_000,
  migration: 60 * 60_000,
};

// A keeper isn't "stalled" the instant it's one tick late — a single slow or
// skipped run is normal jitter (a cold start, a transient RPC hiccup that
// the keeper's own retry logic already absorbed). Multiply the schedule
// interval by this before calling it overdue.
const OVERDUE_MULTIPLIER = 2;

const DEFAULT_STORE_TIMEOUT_MS = 5_000;

export interface KeeperHeartbeatStore {
  /** Returns the last recorded success time in epoch ms, or null if none is recorded. */
  get(key: string): Promise<number | null>;
  /** Unconditionally records `atMs` as the latest success time for `key`. */
  set(key: string, atMs: number): Promise<void>;
}

export function heartbeatKey(
  keeper: "accrual" | "migration",
  network: string
): string {
  return ["meridian", "keeper", "heartbeat", keeper, network].join(":");
}

/**
 * Records a successful keeper run. Never throws: a heartbeat write failing
 * must not take the run down with it, since the run itself already
 * succeeded — only the dashboard's visibility into that success is at
 * stake, not the run's own correctness.
 */
export async function recordKeeperHeartbeat(
  store: KeeperHeartbeatStore,
  keeper: "accrual" | "migration",
  network: string,
  logger: KeeperLogger,
  now = Date.now()
): Promise<void> {
  try {
    await store.set(heartbeatKey(keeper, network), now);
  } catch (err) {
    logger.warn(`[${keeper}-keeper] could not record heartbeat`, {
      error: errorMessage(err),
    });
  }
}

/**
 * Reads the last recorded success time. Never throws: a store outage
 * surfaces as `null` (indistinguishable from "never recorded"), which the
 * health endpoint reports as unhealthy rather than failing the whole
 * request over a monitoring-store hiccup.
 */
export async function getKeeperHeartbeat(
  store: KeeperHeartbeatStore,
  keeper: "accrual" | "migration",
  network: string,
  logger: KeeperLogger
): Promise<number | null> {
  try {
    return await store.get(heartbeatKey(keeper, network));
  } catch (err) {
    logger.warn(`[${keeper}-keeper] could not read heartbeat`, {
      error: errorMessage(err),
    });
    return null;
  }
}

/** Whether a keeper counts as healthy given its last success time and `now`. */
export function isKeeperHealthy(
  keeper: "accrual" | "migration",
  lastSuccessMs: number | null,
  now = Date.now()
): boolean {
  if (lastSuccessMs === null) return false;
  return now - lastSuccessMs <= KEEPER_SCHEDULE_MS[keeper] * OVERDUE_MULTIPLIER;
}

/**
 * Per-process store. Like keeper-state.ts's in-memory fallback, this is
 * useful for tests and local dev but shares nothing across serverless
 * invocations — see `loadKeeperHeartbeatStore` for when it's used.
 */
export function createInMemoryKeeperHeartbeatStore(): KeeperHeartbeatStore {
  const entries = new Map<string, number>();
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, atMs) {
      entries.set(key, atMs);
    },
  };
}

/**
 * Upstash Redis store, over the same REST API keeper-state.ts and
 * api/_lib/middleware.ts already use. Spoken over plain `fetch` for the same
 * reason as keeper-state.ts: this package is imported by the web build as
 * well as the API, and a couple of Redis commands don't justify a client
 * dependency.
 *
 * No TTL: unlike a submission lease, a heartbeat that goes silent because
 * the keeper is genuinely broken should keep reporting its last (now stale)
 * success time indefinitely, not quietly expire back to "never recorded"
 * and lose the "last seen" information the dashboard needs most.
 */
export function createUpstashKeeperHeartbeatStore(options: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): KeeperHeartbeatStore {
  const url = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;

  async function command(args: (string | number)[]): Promise<unknown> {
    const response = await withRaceTimeout(
      () =>
        fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      timeoutMs,
      "Upstash Redis"
    );
    if (!response.ok) {
      throw new Error(
        `Upstash Redis request failed with HTTP ${response.status}`
      );
    }
    const body = (await response.json()) as {
      result?: unknown;
      error?: string;
    };
    if (body.error) throw new Error(`Upstash Redis error: ${body.error}`);
    return body.result ?? null;
  }

  return {
    async get(key) {
      const value = await command(["GET", key]);
      if (typeof value !== "string") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    },
    async set(key, atMs) {
      await command(["SET", key, String(atMs)]);
    },
  };
}

/**
 * Picks the heartbeat store from the environment. Unlike
 * `loadKeeperStateStore`, never refuses to run on a deployed environment
 * without Upstash configured: a missing heartbeat store degrades the
 * dashboard's visibility, not the keeper's correctness, so this only warns.
 */
export function loadKeeperHeartbeatStore(
  env: Record<string, string | undefined>,
  options: {
    logger: KeeperLogger;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }
): KeeperHeartbeatStore {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) {
    return createUpstashKeeperHeartbeatStore({
      url,
      token,
      ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    });
  }
  const deployed = Boolean(env.VERCEL_ENV);
  const message =
    "[keeper-heartbeat] no shared heartbeat store configured; the admin dashboard's Keeper Health card will not see this run's success across invocations";
  if (deployed) {
    options.logger.warn(message, { store: "in-memory", env: env.VERCEL_ENV });
  } else {
    options.logger.info(message, { store: "in-memory" });
  }
  return createInMemoryKeeperHeartbeatStore();
}
