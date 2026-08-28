// Cross-invocation submission tracking for scheduled keepers (#515).
//
// keeper-tx.ts's `priorHash` only lives inside a single invocation: if the
// process is killed (or a run exhausts its retries) while a transaction is
// sent but unconfirmed, the next cron tick has no memory of it. For
// `accrue()` that costs a wasted fee; for `migrate_adapter` it costs real
// slippage twice, since each call is its own slippage-bounded transaction.
//
// The unit of state is a lease on one keeper target, taken in two steps:
//
//  1. `SET NX` a hash-less claim *before* the transaction is built. This is
//     what makes "no record" mean "nobody is working on this target": a
//     plain read beforehand would let two genuinely concurrent invocations
//     (a scheduled run overlapping a manual `workflow_dispatch`) both see
//     nothing and both broadcast. Claims are short-lived, so a crash during
//     build costs a bounded delay, not a stuck target.
//  2. Compare-and-set the real transaction hash into that claim as soon as
//     the transaction is *signed*, before `sendTransaction` is called. The
//     hash is derivable from the signed transaction, so a transaction that
//     reaches the mempool and then times out, or comes back
//     TRY_AGAIN_LATER, is always covered by a record. The cost is that a
//     crash between signing and broadcasting leaves a record for a
//     transaction that never went out; that record ages out at the
//     transaction's own validity window, which is exactly when it becomes
//     provably unable to land.
//
// Every write after the claim is conditional on the exact record this run
// put there (`revision`), so a slow run can never clobber or clear a newer
// run's record and hand a third run a clean slate to rebroadcast into.
//
// A record is never trusted on its word: every run resolves it by looking
// the hash up on-network, so "still unconfirmed" is an observed answer, not
// an assumption. See apps/docs/operations/migration-keeper.md for the state
// machine.

import { withRaceTimeout, withRetry } from "@meridian/shared";
import {
  errorMessage,
  parsePositiveInt,
  type KeeperLogger,
} from "./keeper-retry";
import { TX_VALIDITY_WINDOW_MS, type KeeperSubmissionHooks } from "./keeper-tx";

// A submitted transaction can never land more than TX_VALIDITY_WINDOW_MS
// after it was built (keeper-tx.ts builds with that as its `setTimeout`).
// The extra 60s is margin for clock skew between this process and the
// network, and for the gap between building and broadcasting.
export const DEFAULT_SUBMISSION_TTL_MS = TX_VALIDITY_WINDOW_MS + 60_000;

// How long an unupgraded claim (no hash yet) blocks the target. Only has to
// cover build + simulate + sign, which is bounded by the keepers' own
// function budget; deliberately far shorter than the submission TTL, since
// a claim that never became a transaction is blocking for nothing.
export const DEFAULT_CLAIM_TTL_MS = 60_000;

// Every store round trip is bounded: an unbounded KV call can stall a run
// past the platform's maxDuration, and the worst moment for that is right
// after a transaction was broadcast.
export const DEFAULT_STORE_TIMEOUT_MS = 5_000;

// Recording a signed transaction's hash (SubmissionLease.write) is retried
// on a transient store failure rather than swallowed on the first error: a
// swallowed failure here leaves the claim (short TTL, no hash) as the only
// record of a transaction that is actually in flight, aging out on the
// claim window instead of the transaction's real validity window and
// letting a concurrent run rebroadcast it.
const WRITE_RETRY_ATTEMPTS = 3;
const WRITE_RETRY_BASE_DELAY_MS = 200;

export interface SubmissionRecord {
  // null while a run has claimed the target but has not signed a
  // transaction for it yet.
  hash: string | null;
  updatedAtMs: number;
}

// The record plus the exact serialized bytes it was read/written as, which
// every conditional write compares against. Without it, "delete this key"
// is unconditional and races: run A resolving an old hash could clear the
// record run B had already replaced it with, leaving run C free to
// rebroadcast.
export interface StoredRecord {
  record: SubmissionRecord;
  revision: string;
}

export interface KeeperStateStore {
  get(key: string): Promise<StoredRecord | null>;
  /** SET NX. Returns the stored claim on success, null if someone else holds the key. */
  claim(
    key: string,
    record: SubmissionRecord,
    ttlMs: number
  ): Promise<StoredRecord | null>;
  /** Compare-and-set against `expectedRevision`. Null when the stored value moved on. */
  replace(
    key: string,
    record: SubmissionRecord,
    ttlMs: number,
    expectedRevision: string
  ): Promise<StoredRecord | null>;
  /** Compare-and-delete against `expectedRevision`. False when the stored value moved on. */
  deleteIf(key: string, expectedRevision: string): Promise<boolean>;
}

// Structural rather than `Pick<rpc.Server, "getTransaction">` so this module
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
  | { state: "expired"; hash: string | null }
  | { state: "in-flight"; hash: string; ageMs: number }
  // Another run has claimed this target but has not signed anything yet.
  | { state: "claimed"; ageMs: number }
  // The store or the RPC lookup itself failed, so whether a prior
  // submission is still in flight is unknown. Deliberately distinct from
  // "none": treating an unreadable store as "nothing was submitted" would
  // turn a KV outage into exactly the duplicate submission this module
  // exists to prevent. What a keeper does with it depends on what its own
  // duplicate costs, see `blockOnUnknown` in each keeper.
  | { state: "unknown"; reason: string };

export function serializeRecord(record: SubmissionRecord): string {
  return JSON.stringify({ hash: record.hash, updatedAtMs: record.updatedAtMs });
}

export function parseSubmissionTtlMs(
  env: Record<string, string | undefined>
): number {
  const ttlMs = parsePositiveInt(
    env.MERIDIAN_KEEPER_SUBMISSION_TTL_MS,
    DEFAULT_SUBMISSION_TTL_MS,
    "MERIDIAN_KEEPER_SUBMISSION_TTL_MS"
  );
  // A TTL shorter than the transaction's own validity window turns the
  // "aged out, so provably dead" expiry into a duplicate generator: the
  // record would be cleared while the original transaction can still land.
  if (ttlMs < TX_VALIDITY_WINDOW_MS) {
    throw new Error(
      `MERIDIAN_KEEPER_SUBMISSION_TTL_MS must be at least ${TX_VALIDITY_WINDOW_MS} (a submitted transaction stays valid that long, so a shorter record would expire while it can still land)`
    );
  }
  return ttlMs;
}

/**
 * Key for one keeper target's submission lease. Namespaced by keeper and
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
 * to decide about.
 */
export async function resolvePriorSubmission(options: {
  store: KeeperStateStore;
  key: string;
  server: KeeperTxLookup;
  ttlMs: number;
  logger: KeeperLogger;
  claimTtlMs?: number;
  rpcTimeoutMs?: number;
  context?: Record<string, unknown>;
  now?: number;
}): Promise<PriorSubmission> {
  const { store, key, server, ttlMs, logger } = options;
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
  const context = options.context ?? {};
  const now = options.now ?? Date.now();

  let stored: StoredRecord | null;
  try {
    stored = await store.get(key);
  } catch (err) {
    logger.warn("[keeper-state] could not read prior submission record", {
      ...context,
      error: errorMessage(err),
    });
    return { state: "unknown", reason: "submission state store unavailable" };
  }
  if (!stored) return { state: "none" };

  const { record, revision } = stored;
  const ageMs = now - record.updatedAtMs;

  // A claim with no hash: another run is mid-build, or died mid-build. It
  // ages out on the much shorter claim window, since nothing was ever
  // signed and there is no transaction that could still land.
  if (record.hash === null) {
    if (ageMs > claimTtlMs) {
      await clearRecord(store, key, revision, logger, context);
      return { state: "expired", hash: null };
    }
    return { state: "claimed", ageMs };
  }

  let lookup: { status?: string; ledger?: number } | null | undefined;
  try {
    lookup = await withRaceTimeout(
      () => server.getTransaction(record.hash as string),
      rpcTimeoutMs,
      "Soroban RPC"
    );
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
    await clearRecord(store, key, revision, logger, context);
    return {
      state: "landed",
      hash: record.hash,
      ...(lookup?.ledger !== undefined && { ledger: lookup.ledger }),
    };
  }
  if (status === "FAILED") {
    await clearRecord(store, key, revision, logger, context);
    return { state: "failed", hash: record.hash };
  }

  // NOT_FOUND (or any status this client doesn't recognise): the network has
  // no opinion yet. Age it out against the transaction's own validity window
  // rather than waiting on a human, so a record can never block forever.
  if (ageMs > ttlMs) {
    await clearRecord(store, key, revision, logger, context);
    return { state: "expired", hash: record.hash };
  }
  return { state: "in-flight", hash: record.hash, ageMs };
}

/** Conditional clear. Never throws; the store's own TTL is the backstop. */
async function clearRecord(
  store: KeeperStateStore,
  key: string,
  revision: string,
  logger: KeeperLogger,
  context: Record<string, unknown>
): Promise<boolean> {
  try {
    const cleared = await store.deleteIf(key, revision);
    if (!cleared) {
      // Benign and worth seeing: another run replaced the record between
      // this run reading it and clearing it. Leaving it alone is the whole
      // point of the conditional delete.
      logger.info("[keeper-state] record changed before it could be cleared", {
        ...context,
      });
    }
    return cleared;
  } catch (err) {
    logger.warn("[keeper-state] could not clear submission record", {
      ...context,
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * One run's exclusive hold on one keeper target, from before the
 * transaction is built until its fate is known.
 *
 * Every method is failure-tolerant by design: once a transaction is signed,
 * a store error must never surface as a submission error, because the retry
 * loop answers those by broadcasting a second transaction, exactly the
 * duplicate this exists to prevent.
 */
export class SubmissionLease {
  private held: StoredRecord | null;

  private constructor(
    private readonly store: KeeperStateStore,
    private readonly key: string,
    private readonly submissionTtlMs: number,
    private readonly logger: KeeperLogger,
    private readonly context: Record<string, unknown>,
    claim: StoredRecord
  ) {
    this.held = claim;
  }

  /**
   * Takes the lease with SET NX. Returns null when another run already holds
   * the target (the caller skips it) or when the store is unreachable and
   * `blockOnUnknown` says a duplicate is not worth risking.
   */
  static async acquire(options: {
    store: KeeperStateStore;
    key: string;
    submissionTtlMs: number;
    logger: KeeperLogger;
    claimTtlMs?: number;
    context?: Record<string, unknown>;
    now?: number;
  }): Promise<{ lease: SubmissionLease } | { error: string }> {
    const context = options.context ?? {};
    const now = options.now ?? Date.now();
    let claim: StoredRecord | null;
    try {
      claim = await options.store.claim(
        options.key,
        { hash: null, updatedAtMs: now },
        options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
      );
    } catch (err) {
      options.logger.warn("[keeper-state] could not claim the target", {
        ...context,
        error: errorMessage(err),
      });
      return { error: "submission state store unavailable" };
    }
    if (!claim) {
      return { error: "another run already holds this target" };
    }
    return {
      lease: new SubmissionLease(
        options.store,
        options.key,
        options.submissionTtlMs,
        options.logger,
        context,
        claim
      ),
    };
  }

  /** Whether this run still holds a claim that never became a transaction. */
  get unsent(): boolean {
    return this.held !== null && this.held.record.hash === null;
  }

  /**
   * Records the signed transaction's hash, conditional on this run still
   * holding what it wrote last. Called before `sendTransaction`, so a
   * transaction that reaches the mempool is covered even if the send call
   * times out or is deferred.
   */
  private async write(hash: string, now = Date.now()): Promise<void> {
    if (!this.held) return;
    const revision = this.held.revision;
    try {
      const next = await withRetry(
        () =>
          this.store.replace(
            this.key,
            { hash, updatedAtMs: now },
            this.submissionTtlMs,
            revision
          ),
        WRITE_RETRY_ATTEMPTS,
        WRITE_RETRY_BASE_DELAY_MS
      );
      if (!next) {
        // Lost the lease (claim expired and someone else took it). Stop
        // touching the key: it now belongs to another run.
        this.logger.warn("[keeper-state] lost the submission lease", {
          ...this.context,
          hash,
        });
        this.held = null;
        return;
      }
      this.held = next;
    } catch (err) {
      // Every retry failed: the claim (short TTL, no hash) is still what's
      // stored, so this signed, in-flight transaction is only covered until
      // the much shorter claim window ages out, not its real validity
      // window. Logged loudly since a concurrent run that outlives the
      // claim TTL will read "expired" and rebroadcast.
      this.logger.warn(
        "[keeper-state] could not record submission after retries; the claim covering it will age out early",
        {
          ...this.context,
          hash,
          error: errorMessage(err),
        }
      );
    }
  }

  /** Clears this run's record once the transaction's fate is known. */
  private async clear(): Promise<void> {
    if (!this.held) return;
    const revision = this.held.revision;
    this.held = null;
    await clearRecord(
      this.store,
      this.key,
      revision,
      this.logger,
      this.context
    );
  }

  /**
   * Releases a claim that never became a signed transaction (a simulation
   * error, a deadline, a rejected build), so the next run isn't blocked for
   * the claim's full window over a target nothing was ever sent for.
   */
  async releaseIfUnsent(): Promise<void> {
    if (this.unsent) await this.clear();
  }

  /** Hooks to hand to submitKeeperOperation (see keeper-tx.ts). */
  get hooks(): KeeperSubmissionHooks {
    return {
      onSigned: (hash) => this.write(hash),
      onResolved: () => this.clear(),
    };
  }
}

/**
 * Per-process store. Useful in tests and local dev, but note what it is not:
 * keeper invocations are separate serverless executions, so nothing written
 * here survives to the next run. It keeps the code path identical without
 * pretending to provide cross-invocation dedup; only a shared store does.
 */
export function createInMemoryKeeperStateStore(): KeeperStateStore {
  const entries = new Map<string, { value: string; expiresAt: number }>();

  function read(key: string): string | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(key) {
      const value = read(key);
      return value === null ? null : hydrate(value);
    },
    async claim(key, record, ttlMs) {
      if (read(key) !== null) return null;
      const value = serializeRecord(record);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      return { record, revision: value };
    },
    async replace(key, record, ttlMs, expectedRevision) {
      if (read(key) !== expectedRevision) return null;
      const value = serializeRecord(record);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      return { record, revision: value };
    },
    async deleteIf(key, expectedRevision) {
      if (read(key) !== expectedRevision) return false;
      entries.delete(key);
      return true;
    },
  };
}

function hydrate(value: string): StoredRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { hash, updatedAtMs } = parsed as Partial<SubmissionRecord>;
  if (hash !== null && typeof hash !== "string") return null;
  if (hash === "") return null;
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) {
    return null;
  }
  return { record: { hash, updatedAtMs }, revision: value };
}

// Compare-and-set / compare-and-delete need to be atomic against the stored
// value, which the REST API can only express through a script.
const CAS_SET =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 else return 0 end";
const CAS_DEL =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/**
 * Upstash Redis store, over the REST API the rest of this repo already
 * points at for rate limiting (`api/_lib/middleware.ts`), reusing the same
 * `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` pair.
 *
 * Spoken over plain `fetch` rather than `@upstash/redis` on purpose: this
 * package is the shared Stellar helper library, imported by the web build as
 * well as the API, and a handful of Redis commands don't justify pulling a
 * client dependency into it.
 *
 * Every record is written with a Redis-side expiry as well, so even a run
 * that dies before it can clear a record cannot leave one behind past the
 * point where its transaction could still land.
 */
export function createUpstashKeeperStateStore(options: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): KeeperStateStore {
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
          // Belt and braces with the race below: this also frees the socket
          // rather than leaving a hung request running past the run.
          signal: AbortSignal.timeout(timeoutMs),
        }),
      timeoutMs,
      "Upstash Redis"
    );
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
      const value = await command(["GET", key]);
      return typeof value === "string" ? hydrate(value) : null;
    },
    async claim(key, record, ttlMs) {
      const value = serializeRecord(record);
      // PX, not EX: these windows are derived from millisecond transaction
      // bounds, and rounding up to whole seconds would keep a dead record
      // blocking longer than the transaction it tracks could live.
      const result = await command([
        "SET",
        key,
        value,
        "NX",
        "PX",
        expiry(ttlMs),
      ]);
      return result === null ? null : { record, revision: value };
    },
    async replace(key, record, ttlMs, expectedRevision) {
      const value = serializeRecord(record);
      const result = await command([
        "EVAL",
        CAS_SET,
        1,
        key,
        expectedRevision,
        value,
        String(expiry(ttlMs)),
      ]);
      return Number(result) === 1 ? { record, revision: value } : null;
    },
    async deleteIf(key, expectedRevision) {
      const result = await command(["EVAL", CAS_DEL, 1, key, expectedRevision]);
      return Number(result) === 1;
    },
  };
}

function expiry(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs));
}

/**
 * Picks the submission state store from the environment.
 *
 * `requireShared` is the migration keeper: a duplicate `migrate_adapter`
 * costs real slippage twice, so on any deployed environment it refuses to
 * run without a shared store rather than silently degrading to a
 * per-process one that cannot dedup across invocations at all. Preview
 * counts as deployed: preview deployments sign real transactions off a real
 * key (see `api/_lib/middleware.ts`), so "not production" is not the same as
 * "not real".
 */
export function loadKeeperStateStore(
  env: Record<string, string | undefined>,
  options: {
    keeper: "accrual" | "migration";
    requireShared: boolean;
    logger: KeeperLogger;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }
): KeeperStateStore {
  // Vercel's own Upstash Marketplace integration provisions credentials
  // under a store-prefixed name, not the plain UPSTASH_REDIS_REST_URL/_TOKEN
  // a manually-configured Upstash instance uses. Accept either.
  const url = (
    env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_REST_KV_REST_API_URL
  )?.trim();
  const token = (
    env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  )?.trim();
  if (url && token) {
    return createUpstashKeeperStateStore({
      url,
      token,
      ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    });
  }
  const deployed = Boolean(env.VERCEL_ENV);
  if (options.requireShared && deployed) {
    throw new Error(
      `Refusing to run the migration keeper on a ${env.VERCEL_ENV} deployment: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required (the in-memory fallback is per-invocation and cannot prevent a duplicate migrate_adapter)`
    );
  }
  // Warn, not info, on anything deployed: falling back reinstates the exact
  // duplicate-submission gap this module exists to close, and that should be
  // visible in logs rather than buried at info level. Local dev, where the
  // fallback is the expected state, stays quiet.
  const message = `[${options.keeper}-keeper] no shared submission state store configured; cross-invocation dedup is inactive for this run`;
  if (deployed) {
    options.logger.warn(message, { store: "in-memory", env: env.VERCEL_ENV });
  } else {
    options.logger.info(message, { store: "in-memory" });
  }
  return createInMemoryKeeperStateStore();
}
