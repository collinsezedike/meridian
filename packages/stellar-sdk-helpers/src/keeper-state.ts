// Cross-invocation submission tracking for scheduled keepers (#515).
//
// keeper-tx.ts's `priorHash` only lives inside a single invocation: if the
// process is killed (or a run exhausts its retries) while a transaction is
// sent but unconfirmed, the next cron tick has no memory of it. For
// `accrue()` that costs a wasted fee; for `migrate_adapter` it costs real
// slippage twice, since each call is its own slippage-bounded transaction.
//
// The state kept here is deliberately minimal: one record per keeper target,
// written *only after* a transaction was broadcast and a hash came back.
// There is no "about to send" state at all, so a crash before broadcast
// leaves nothing behind to block the next run. The mirror gap (broadcast
// succeeds, then the process dies before the record is written) is not
// closable with a record alone; it's covered by the on-chain adapter
// re-check both keepers run before building a new transaction
// (assertAdapterUnchanged in keeper-tx.ts).
//
// A record is never trusted on its word: every run resolves it by looking
// the hash up on-network, so "still unconfirmed" is an observed answer, not
// an assumption, and a record can never block a target indefinitely. See
// apps/docs/operations/migration-keeper.md for the state machine.

import {
  errorMessage,
  parsePositiveInt,
  type KeeperLogger,
} from "./keeper-retry";

// submitKeeperOperation builds transactions with `.setTimeout(300)`, so a
// submitted transaction can never land more than 300s after it was built.
// Past that it is provably dead, whatever the RPC says. The extra 60s is
// margin for clock skew between this process and the network, and for the
// gap between building and broadcasting.
export const DEFAULT_SUBMISSION_TTL_MS = 360_000;

export interface SubmissionRecord {
  hash: string;
  submittedAtMs: number;
}

// Intentionally tiny: anything a keeper needs beyond "was this hash
// submitted, and when" is derivable from the chain, and a wider interface
// would be a second source of truth to keep in sync.
export interface KeeperStateStore {
  get(key: string): Promise<SubmissionRecord | null>;
  set(key: string, record: SubmissionRecord, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// Structural, not `Pick<rpc.Server, "getTransaction">`, so this module never
// imports from keeper-tx.ts (which imports the hook types defined here) and
// never depends on the SDK's enum objects, which the keeper tests mock away.
export interface KeeperTxLookup {
  getTransaction(
    hash: string
  ): Promise<{ status?: string; ledger?: number } | null | undefined>;
}

export type PriorSubmission =
  | { state: "none" }
  | { state: "landed"; hash: string; ledger?: number }
  | { state: "failed"; hash: string }
  | { state: "expired"; hash: string }
  | { state: "in-flight"; hash: string; ageMs: number }
  // The store or the RPC lookup itself failed, so whether a prior
  // submission is still in flight is unknown. Deliberately distinct from
  // "none": treating an unreadable store as "nothing was submitted" would
  // turn a KV outage into exactly the duplicate submission this module
  // exists to prevent.
  | { state: "unknown"; reason: string };

export function parseSubmissionTtlMs(
  env: Record<string, string | undefined>
): number {
  return parsePositiveInt(
    env.MERIDIAN_KEEPER_SUBMISSION_TTL_MS,
    DEFAULT_SUBMISSION_TTL_MS,
    "MERIDIAN_KEEPER_SUBMISSION_TTL_MS"
  );
}

/**
 * Key for one keeper target's in-flight submission. Namespaced by keeper and
 * network so the accrue and migration keepers can never read each other's
 * records, and so a testnet run can never block a mainnet one.
 */
export function submissionStateKey(
  keeper: "accrual" | "migration",
  network: string,
  ...target: string[]
): string {
  return ["meridian", "keeper", keeper, network, ...target].join(":");
}

/**
 * Resolves whatever the store holds for `key` against the network, clearing
 * the record whenever the underlying transaction's fate becomes known.
 *
 * Never throws: a keeper's dedup check failing must not take the run down
 * with it, so a store or lookup failure surfaces as `unknown` for the caller
 * to decide about (both keepers skip that target for the run).
 */
export async function resolvePriorSubmission(options: {
  store: KeeperStateStore;
  key: string;
  server: KeeperTxLookup;
  ttlMs: number;
  logger: KeeperLogger;
  context?: Record<string, unknown>;
  now?: number;
}): Promise<PriorSubmission> {
  const { store, key, server, ttlMs, logger } = options;
  const context = options.context ?? {};
  const now = options.now ?? Date.now();

  let record: SubmissionRecord | null;
  try {
    record = await store.get(key);
  } catch (err) {
    logger.warn("[keeper-state] could not read prior submission record", {
      ...context,
      error: errorMessage(err),
    });
    return { state: "unknown", reason: "submission state store unavailable" };
  }
  if (!record) return { state: "none" };

  let lookup: { status?: string; ledger?: number } | null | undefined;
  try {
    lookup = await server.getTransaction(record.hash);
  } catch (err) {
    logger.warn("[keeper-state] could not look up prior submission", {
      ...context,
      hash: record.hash,
      error: errorMessage(err),
    });
    return {
      state: "unknown",
      reason: "prior submission status could not be checked",
    };
  }

  const status = lookup?.status;
  if (status === "SUCCESS") {
    await clearSubmission(store, key, logger, context);
    return {
      state: "landed",
      hash: record.hash,
      ...(lookup?.ledger !== undefined && { ledger: lookup.ledger }),
    };
  }
  if (status === "FAILED") {
    await clearSubmission(store, key, logger, context);
    return { state: "failed", hash: record.hash };
  }

  // NOT_FOUND (or any status this client doesn't recognise): the network has
  // no opinion yet. Age it out against the transaction's own validity window
  // rather than waiting on a human, so a record can never block forever.
  const ageMs = now - record.submittedAtMs;
  if (ageMs > ttlMs) {
    await clearSubmission(store, key, logger, context);
    return { state: "expired", hash: record.hash };
  }
  return { state: "in-flight", hash: record.hash, ageMs };
}

/**
 * Records a broadcast transaction. Called only after `sendTransaction`
 * returned a hash, never before: there is deliberately no "started" state
 * that a crash could leave behind.
 *
 * Never throws. A failed write means this run loses cross-invocation dedup
 * for that target (the on-chain adapter re-check is the remaining guard),
 * which is strictly better than turning a KV blip into a submission error
 * the retry loop would answer by broadcasting a second transaction.
 */
export async function recordSubmission(
  store: KeeperStateStore,
  key: string,
  hash: string,
  ttlMs: number,
  logger: KeeperLogger,
  context: Record<string, unknown> = {},
  now: number = Date.now()
): Promise<void> {
  try {
    await store.set(key, { hash, submittedAtMs: now }, ttlMs);
  } catch (err) {
    logger.warn("[keeper-state] could not record submission", {
      ...context,
      hash,
      error: errorMessage(err),
    });
  }
}

/** Clears a resolved record. Never throws; the store's own TTL is the backstop. */
export async function clearSubmission(
  store: KeeperStateStore,
  key: string,
  logger: KeeperLogger,
  context: Record<string, unknown> = {}
): Promise<void> {
  try {
    await store.delete(key);
  } catch (err) {
    logger.warn("[keeper-state] could not clear submission record", {
      ...context,
      error: errorMessage(err),
    });
  }
}

/**
 * Per-process store. Useful in tests and local dev, but note what it is not:
 * keeper invocations are separate serverless executions, so nothing written
 * here survives to the next run. It keeps the code path identical without
 * pretending to provide cross-invocation dedup; only a shared store does.
 */
export function createInMemoryKeeperStateStore(): KeeperStateStore {
  const records = new Map<
    string,
    { record: SubmissionRecord; expiresAt: number }
  >();
  return {
    async get(key) {
      const entry = records.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        records.delete(key);
        return null;
      }
      return entry.record;
    },
    async set(key, record, ttlMs) {
      records.set(key, { record, expiresAt: Date.now() + ttlMs });
    },
    async delete(key) {
      records.delete(key);
    },
  };
}

function parseRecord(value: unknown): SubmissionRecord | null {
  if (typeof value !== "string" || value === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { hash, submittedAtMs } = parsed as Partial<SubmissionRecord>;
  if (typeof hash !== "string" || hash === "") return null;
  if (typeof submittedAtMs !== "number" || !Number.isFinite(submittedAtMs)) {
    return null;
  }
  return { hash, submittedAtMs };
}

/**
 * Upstash Redis store, over the REST API the rest of this repo already
 * points at for rate limiting (`api/_lib/middleware.ts`), reusing the same
 * `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` pair.
 *
 * Spoken over plain `fetch` rather than `@upstash/redis` on purpose: this
 * package is the shared Stellar helper library, imported by the web build as
 * well as the API, and three Redis commands don't justify pulling a client
 * dependency into it.
 *
 * Every record is written with a Redis-side expiry as well, so even a run
 * that dies before it can clear a record cannot leave one behind past the
 * point where its transaction could still land.
 */
export function createUpstashKeeperStateStore(options: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}): KeeperStateStore {
  const url = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function command(args: (string | number)[]): Promise<unknown> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      // Deliberately status-only: the response body can echo the command,
      // and the URL/token never appear in the message at all.
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
      return parseRecord(await command(["GET", key]));
    },
    async set(key, record, ttlMs) {
      // PX, not EX: the TTL is derived from the transaction's millisecond
      // validity window, and rounding it up to whole seconds would keep a
      // dead record blocking for up to a second longer than the transaction
      // it tracks could possibly live.
      await command([
        "SET",
        key,
        JSON.stringify(record),
        "PX",
        Math.max(1, Math.ceil(ttlMs)),
      ]);
    },
    async delete(key) {
      await command(["DEL", key]);
    },
  };
}

/**
 * Picks the submission state store from the environment.
 *
 * `requireShared` is the migration keeper: a duplicate `migrate_adapter`
 * costs real slippage twice, so in production it refuses to run without a
 * shared store rather than silently degrading to a per-process one that
 * cannot dedup across invocations. This mirrors the same refusal
 * `api/_lib/middleware.ts` already makes for distributed rate limiting, so
 * production deployments already have Upstash configured.
 */
export function loadKeeperStateStore(
  env: Record<string, string | undefined>,
  options: {
    keeper: "accrual" | "migration";
    requireShared: boolean;
    logger: KeeperLogger;
    fetchImpl?: typeof fetch;
  }
): KeeperStateStore {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) {
    return createUpstashKeeperStateStore({
      url,
      token,
      ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
    });
  }
  if (options.requireShared && env.VERCEL_ENV === "production") {
    throw new Error(
      "Refusing to run the migration keeper: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required when VERCEL_ENV=production (the in-memory fallback is per-invocation and cannot prevent a duplicate migrate_adapter)"
    );
  }
  options.logger.info(
    `[${options.keeper}-keeper] no shared submission state store configured; cross-invocation dedup is inactive for this run`,
    { store: "in-memory" }
  );
  return createInMemoryKeeperStateStore();
}
