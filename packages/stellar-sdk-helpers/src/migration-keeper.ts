// Scheduled keeper for #469: periodically compares live rates across the
// protocols a Meridian vault's adapters can target, and calls the vault's
// existing migrate_adapter when a candidate clears a configured minimum
// improvement. migrate_adapter already moves the vault's entire position in
// one slippage-bounded transaction and never touches individual depositor
// balances, so triggering it automatically needs no new authorization
// primitive; see apps/docs/operations/migration-keeper.md for the full
// trust model this keeper's signing key carries.
//
// Rate comparison is pluggable (see RateSourceFn below): neither adapter
// contract exposes a ready-made comparable rate today, so the default
// source (see rate-sources.ts) computes one for each protocol out of what
// the on-chain data actually provides. This mirrors the accrual keeper's
// own shape (discovery, retry, structured failure reporting, deadline
// budget); see accrual-keeper.ts.

import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { APP_NETWORK } from "@meridian/shared";
import { KNOWN_POOLS, type KnownPoolMeta } from "./known-pools";
import { getRpcServer } from "./internal";
import { simulateView } from "./tx";
import { createDefaultRateSource } from "./rate-sources";
import type { StellarNetwork } from "./types";
import {
  consoleLogger,
  errorMessage,
  parseNonNegativeInt,
  parsePositiveInt,
  redactedErrorMessage,
  retryOutcome,
  sleep,
  withKeeperRetry,
  type KeeperFailure,
  type KeeperLogger,
  type RetryConfig,
} from "./keeper-retry";
import {
  assertAdapterUnchanged,
  expectString,
  isStaleAdapterError,
  isTransientKeeperError,
  submitKeeperOperation,
  SubmissionInFlightError,
  type KeeperRpcServer,
  type KeeperSubmissionHooks,
} from "./keeper-tx";
import {
  loadKeeperStateStore,
  parseSubmissionTtlMs,
  resolvePriorSubmission,
  submissionStateKey,
  SubmissionLease,
  type KeeperStateStore,
} from "./keeper-state";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
// Same rationale as accrual-keeper.ts's DEFAULT_RPC_TIMEOUT_MS: discovery's
// simulate() calls are additionally capped at tx.ts's hardcoded 10s Soroban
// RPC ceiling regardless of what's configured here.
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
// Same rationale as accrual-keeper.ts's CONFIRMATION_TIMEOUT_MS: a ledger
// close, not a bounded API call.
const CONFIRMATION_TIMEOUT_MS = 20_000;
// Same rationale as accrual-keeper.ts's FUNCTION_BUDGET_MS: stay under
// Vercel's maxDuration for this endpoint with a safety margin, see
// vercel.json.
const FUNCTION_BUDGET_MS = 50_000;

// Never unlimited (10_000 bps = 100%) in automated operation: an unbounded
// slippage tolerance would accept a migration that loses an arbitrary
// fraction of the vault's position to a rounding error, a stale rate read,
// or a misbehaving adapter. 100 bps (1%) is a deliberately tight default;
// operators can widen it via config, but the loader rejects 10_000.
const DEFAULT_MAX_SLIPPAGE_BPS = 100;
const MAX_ALLOWED_SLIPPAGE_BPS = 9_999;

// A minimum improvement floor avoids churning between two protocols whose
// rates are within noise of each other: migrate_adapter costs a real
// transaction fee and, while slippage-bounded, is never perfectly
// value-neutral, so chasing a marginal, possibly-noisy improvement can cost
// more than it earns.
const DEFAULT_MIN_IMPROVEMENT_BPS = 50;

// Deliberately a plain string, not a fixed union: migrate_adapter itself
// takes a bare adapter address and has no notion of which protocol it
// wraps, that's the entire point of the adapter pattern. Hardcoding a
// closed set of protocol names here would reintroduce, at the one layer
// whose job is protocol-agnostic routing, exactly the coupling adapters
// exist to avoid. A new protocol becomes usable by configuring an env var,
// see loadMigrationKeeperConfig, never by editing this file.
export interface RateQuery {
  protocol: string;
  adapterId: string;
  poolId: string;
  // Reserve asset (Stellar Asset Contract) to price when the query targets a
  // Blend pool. Threaded from the vault's KNOWN_POOLS entry so a non-USDC
  // vault prices its own reserve (e.g. EURC) in whichever pool it's evaluated
  // against instead of a hardcoded USDC address (#539). Optional: callers that
  // omit it (and the USDC default behavior) are unchanged.
  assetId?: string;
}

/**
 * Returns a comparable annualized rate in basis points for the given
 * adapter/pool, or null when it can't be determined. Pluggable because
 * neither Blend nor DeFindex exposes a ready-made comparable rate today:
 * Blend's adapter only exposes the raw inputs to its own kinked interest
 * rate curve, not a computed rate, and DeFindex's share price needs a
 * second sample over time to derive one. See rate-sources.ts for the real
 * implementations runMigrationKeeper defaults to (createDefaultRateSource);
 * this stays independently injectable via MigrationKeeperDeps.rateSource,
 * both for tests and for swapping in a different implementation without
 * touching this file.
 */
export type RateSourceFn = (query: RateQuery) => Promise<number | null>;

// A RateSourceFn is caller-supplied (see #511); a buggy implementation can
// resolve NaN or Infinity (e.g. a division by zero) instead of throwing or
// returning null. NaN in particular defeats every comparison below it
// (`NaN < threshold` and `x > NaN` are both false), which would let a
// garbage rate silently win as the best candidate rather than being
// rejected. Treat anything non-finite the same as "rate unknown".
function isUsableRate(rate: number | null): rate is number {
  return rate !== null && Number.isFinite(rate);
}

export interface MigrationKeeperConfig {
  network: StellarNetwork;
  secretKey: string;
  maxAttempts: number;
  baseDelayMs: number;
  rpcTimeoutMs: number;
  minImprovementBps: number;
  maxSlippageBps: number;
  submissionTtlMs: number;
  candidateAdapters: Record<string, string>;
}

export interface DiscoveredVault {
  vaultId: string;
  vaultContractId: string;
  currentAdapterId: string;
  currentProtocol: string;
  currentPoolId: string;
  // The vault's underlying reserve asset, resolved from its KNOWN_POOLS entry
  // during discovery (#539). Threaded into every RateQuery so Blend pools are
  // priced on the correct reserve (e.g. EURC) rather than a hardcoded USDC
  // address.
  assetId?: string;
}

export interface MigrationSuccess {
  vaultId: string;
  fromAdapterId: string;
  fromProtocol: string;
  toAdapterId: string;
  toProtocol: string;
  improvementBps: number;
  hash: string;
  ledger: number;
  attempts: number;
}

export interface MigrationSkip {
  vaultId: string;
  reason: string;
}

export interface MigrationKeeperResult {
  network: StellarNetwork["network"];
  startedAt: string;
  finishedAt: string;
  discoveredVaults: number;
  migrations: MigrationSuccess[];
  skipped: MigrationSkip[];
  failures: KeeperFailure[];
}

type SimulateFn = typeof simulateView;

export interface DiscoverVaultsOptions {
  network?: StellarNetwork;
  pools?: Record<string, KnownPoolMeta>;
  server?: KeeperRpcServer;
  simulate?: SimulateFn;
  maxAttempts?: number;
  baseDelayMs?: number;
  deadlineAt?: number;
  logger?: KeeperLogger;
  sleep?: (ms: number) => Promise<void>;
}

export interface MigrationKeeperDeps {
  discoverVaults?: () => Promise<{
    vaults: DiscoveredVault[];
    failures: KeeperFailure[];
  }>;
  rateSource?: RateSourceFn;
  resolveCandidatePool?: (adapterId: string) => Promise<string>;
  // `hooks` carries this run's submission lease: an override that forwards
  // it to submitKeeperOperation keeps cross-invocation dedup; one that
  // ignores it falls back to the claim held for the duration of the run and
  // the on-chain adapter re-check, and is warned about at run start.
  submitMigration?: (
    vault: DiscoveredVault,
    toAdapterId: string,
    attempt: number,
    hooks: KeeperSubmissionHooks
  ) => Promise<
    Omit<
      MigrationSuccess,
      | "attempts"
      | "vaultId"
      | "fromAdapterId"
      | "fromProtocol"
      | "toAdapterId"
      | "toProtocol"
      | "improvementBps"
    >
  >;
  // Cross-invocation submission tracking (#515). Defaults to whatever the
  // environment provides (Upstash Redis when configured); injected in tests.
  stateStore?: KeeperStateStore;
  logger?: KeeperLogger;
  sleep?: (ms: number) => Promise<void>;
  deadlineAt?: number;
}

// Scans for MERIDIAN_ADAPTER_<PROTOCOL>_ID rather than one hardcoded env
// var per protocol: a new protocol becomes a migration candidate by setting
// an env var with this name, never by editing this file, matching how
// RateSourceFn is already pluggable without code changes.
const CANDIDATE_ADAPTER_ENV_PATTERN = /^MERIDIAN_ADAPTER_(.+)_ID$/;

function parseCandidateAdapters(
  env: Record<string, string | undefined>
): Record<string, string> {
  const candidates: Record<string, string> = {};
  // Tracks which raw env var name populated each lowercased protocol key,
  // so two case-differing var names for the same protocol (e.g.
  // MERIDIAN_ADAPTER_BLEND_ID and MERIDIAN_ADAPTER_Blend_ID) fail loudly
  // instead of one silently overwriting the other with no error, log, or
  // indication that a candidate was dropped.
  const sourceKeyByProtocol: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = CANDIDATE_ADAPTER_ENV_PATTERN.exec(key);
    const protocol = match?.[1];
    const trimmed = value?.trim();
    if (!protocol || !trimmed) continue;
    const lower = protocol.toLowerCase();
    const existingKey = sourceKeyByProtocol[lower];
    if (existingKey && existingKey !== key) {
      throw new Error(
        `${existingKey} and ${key} both resolve to the same migration candidate protocol ("${lower}"); set only one`
      );
    }
    sourceKeyByProtocol[lower] = key;
    candidates[lower] = trimmed;
  }
  return candidates;
}

// The one place "is the migration keeper configured" is defined. Callers
// that need to distinguish "intentionally not set up yet" from "actually
// broken" (e.g. the rebalance endpoint's disabled-response check) should
// call this instead of re-deriving the same condition against a raw env
// var name, which would silently drift from loadMigrationKeeperConfig's
// own validation if either one changed without the other.
export function isMigrationKeeperConfigured(
  env: Record<string, string | undefined>
): boolean {
  return Boolean(env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY?.trim());
}

export function loadMigrationKeeperConfig(
  env: Record<string, string | undefined>
): MigrationKeeperConfig {
  // Deliberately its own env var, distinct from MERIDIAN_KEEPER_SECRET_KEY
  // (the accrual keeper's key): accrue() is permissionless, but
  // migrate_adapter is admin-gated, so this key carries full vault admin
  // authority. Operators should be able to scope/rotate the two
  // independently rather than share a single key across a low-stakes and a
  // high-stakes job.
  const secretKey = env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("MERIDIAN_MIGRATION_KEEPER_SECRET_KEY is required");
  }

  const maxSlippageBps = parseNonNegativeInt(
    env.MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS,
    DEFAULT_MAX_SLIPPAGE_BPS,
    "MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS"
  );
  if (maxSlippageBps > MAX_ALLOWED_SLIPPAGE_BPS) {
    throw new Error(
      `MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS must be at most ${MAX_ALLOWED_SLIPPAGE_BPS} (10_000 is unlimited slippage and is never allowed in automated operation)`
    );
  }

  return {
    network: APP_NETWORK,
    secretKey,
    maxAttempts: parsePositiveInt(
      env.MERIDIAN_KEEPER_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
      "MERIDIAN_KEEPER_MAX_ATTEMPTS"
    ),
    baseDelayMs: parsePositiveInt(
      env.MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS,
      DEFAULT_BASE_DELAY_MS,
      "MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS"
    ),
    rpcTimeoutMs: parsePositiveInt(
      env.MERIDIAN_KEEPER_RPC_TIMEOUT_MS,
      DEFAULT_RPC_TIMEOUT_MS,
      "MERIDIAN_KEEPER_RPC_TIMEOUT_MS"
    ),
    minImprovementBps: parseNonNegativeInt(
      env.MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS,
      DEFAULT_MIN_IMPROVEMENT_BPS,
      "MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS"
    ),
    maxSlippageBps,
    submissionTtlMs: parseSubmissionTtlMs(env),
    candidateAdapters: parseCandidateAdapters(env),
  };
}

export async function discoverMigrationVaults(
  options: DiscoverVaultsOptions = {}
): Promise<{ vaults: DiscoveredVault[]; failures: KeeperFailure[] }> {
  const network = options.network ?? APP_NETWORK;
  const networkKey = network.network === "mainnet" ? "mainnet" : "testnet";
  const pools = options.pools ?? KNOWN_POOLS[networkKey];
  const server =
    options.server ?? getRpcServer(network.rpcUrl, DEFAULT_RPC_TIMEOUT_MS);
  const simulate = options.simulate ?? simulateView;
  const logger = options.logger ?? consoleLogger;
  const sleepFn = options.sleep ?? sleep;
  const retryConfig: RetryConfig = {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    ...(options.deadlineAt !== undefined && { deadlineAt: options.deadlineAt }),
  };
  const targets = Object.values(pools).filter(
    (meta) => meta.protocol === "meridian" && meta.contractId
  );

  const settled = await Promise.allSettled(
    targets.map((meta) => {
      const vaultContractId = meta.contractId as string;
      // Cached across this target's own retry attempts (not shared with any
      // other target): a transient failure on get_protocol or get_pool used
      // to also re-issue an already-succeeded get_adapter call (and, for
      // whichever of get_protocol/get_pool already succeeded, that call too)
      // on retry, since all three lived in the same combined closure.
      // Caching whatever already succeeded means a retry only re-issues the
      // call(s) that actually failed.
      let currentAdapterId: string | undefined;
      let currentProtocol: string | undefined;
      let currentPoolId: string | undefined;
      return withKeeperRetry(
        async () => {
          currentAdapterId ??= expectString(
            await simulate(
              server as never,
              vaultContractId,
              network.passphrase,
              "get_adapter"
            ),
            "get_adapter",
            vaultContractId
          );
          const adapterId = currentAdapterId;
          // Independent of each other, both depend only on adapterId: run
          // concurrently rather than doubling this vault's discovery latency
          // for no reason. Promise.allSettled, not Promise.all: if get_pool
          // rejects while get_protocol is still in flight, Promise.all would
          // reject immediately and move on, leaving get_protocol's call
          // still running in the background. A retry starting before that
          // stray call resolves would then see currentProtocol still
          // undefined and issue its own, second get_protocol call, two
          // concurrent calls in flight for the same thing, exactly what the
          // caching above exists to avoid. Waiting for both to settle first
          // means no call from this attempt is ever still in flight once the
          // next attempt starts.
          const [protocolResult, poolResult] = await Promise.allSettled([
            currentProtocol !== undefined
              ? Promise.resolve(currentProtocol)
              : simulate(
                  server as never,
                  adapterId,
                  network.passphrase,
                  "get_protocol"
                ).then((value) =>
                  expectString(value, "get_protocol", adapterId)
                ),
            currentPoolId !== undefined
              ? Promise.resolve(currentPoolId)
              : simulate(
                  server as never,
                  adapterId,
                  network.passphrase,
                  "get_pool"
                ).then((value) => expectString(value, "get_pool", adapterId)),
          ]);
          if (protocolResult.status === "fulfilled") {
            currentProtocol = protocolResult.value;
          }
          if (poolResult.status === "fulfilled") {
            currentPoolId = poolResult.value;
          }
          if (
            protocolResult.status === "rejected" ||
            poolResult.status === "rejected"
          ) {
            // If get_protocol and get_pool reject with different transience
            // (e.g. one transient rate-limit, one permanent "contract not
            // found"), surfacing whichever happens to be checked first would
            // let a permanent failure hide behind a transient one, wasting
            // the full retry budget on a target that was never going to
            // succeed. Prefer the permanent rejection so the keeper stops
            // retrying for the real reason.
            const protocolRejection =
              protocolResult.status === "rejected" ? protocolResult : null;
            const poolRejection =
              poolResult.status === "rejected" ? poolResult : null;
            const permanent = [protocolRejection, poolRejection].find(
              (r): r is PromiseRejectedResult =>
                r !== null && !isTransientKeeperError(r.reason)
            );
            const fallback = protocolRejection ?? poolRejection;
            // fallback can't actually be null here: the outer if already
            // guarantees at least one of protocolResult/poolResult was
            // rejected, so at least one of protocolRejection/poolRejection
            // is non-null.
            throw (permanent ?? fallback)!.reason;
          }
          const protocol = protocolResult.value;
          const poolId = poolResult.value;
          return {
            vaultId: meta.id,
            vaultContractId,
            currentAdapterId: adapterId,
            currentProtocol: protocol,
            currentPoolId: poolId,
            ...(meta.assetId !== undefined && { assetId: meta.assetId }),
          };
        },
        retryConfig,
        logger,
        { vaultId: meta.id, vaultContractId, stage: "discover" },
        sleepFn,
        isTransientKeeperError,
        "migration-keeper"
      );
    })
  );

  const vaults: DiscoveredVault[] = [];
  const failures: KeeperFailure[] = [];
  const pairs = targets.map((meta, i) => ({ meta, outcome: settled[i] }));

  for (const { meta, outcome } of pairs) {
    if (!outcome) continue;
    const vaultContractId = meta.contractId as string;
    if (outcome.status === "fulfilled") {
      vaults.push(outcome.value.value);
      continue;
    }
    const err = outcome.reason;
    const { attempts, transient } = retryOutcome(err, isTransientKeeperError);
    failures.push({
      vaultId: meta.id,
      vaultContractId,
      stage: "discover",
      attempts,
      transient,
      error: redactedErrorMessage(err),
    });
  }

  return { vaults, failures };
}

interface BestCandidate {
  protocol: string;
  adapterId: string;
  improvementBps: number;
}

// Thrown when evaluating a specific candidate (pool resolution or rate
// lookup) fails, after retries are exhausted. Carries which candidate was
// being evaluated so the caller can report a failure against the actual
// adapter that failed, not the vault's current one, and preserves the
// underlying attempts/transient classification so retryOutcome() still
// reports it correctly one level up.
class CandidateEvaluationError extends Error {
  readonly attempts: number;
  readonly transient: boolean;

  constructor(
    readonly protocol: string,
    readonly adapterId: string,
    cause: unknown
  ) {
    const { attempts, transient } = retryOutcome(cause, isTransientKeeperError);
    super(errorMessage(cause));
    this.name = "CandidateEvaluationError";
    this.attempts = attempts;
    this.transient = transient;
  }
}

async function findBestCandidate(
  vault: DiscoveredVault,
  config: MigrationKeeperConfig,
  rateSource: RateSourceFn,
  resolveCandidatePool: (adapterId: string) => Promise<string>,
  logger: KeeperLogger,
  sleepFn: (ms: number) => Promise<void>,
  deadlineAt: number
): Promise<{ best: BestCandidate | null; skipReason?: string }> {
  // Nothing to compare against: don't pay for a retried rate lookup (up to
  // maxAttempts, with backoff) just to discover there was never a candidate
  // to evaluate. This is the documented default state today (no
  // MERIDIAN_ADAPTER_<PROTOCOL>_ID configured), not a rare edge case.
  if (Object.keys(config.candidateAdapters).length === 0) {
    return { best: null, skipReason: "no candidate adapters configured" };
  }

  // Only excludes the vault's literal current adapter, not same-protocol
  // candidates: a redeployed BlendAdapter (scripts/redeploy-blend-adapter.sh)
  // is a legitimate migration target with the same protocol name as the
  // vault's current one, and migrate_adapter itself has no protocol-based
  // restriction, only "not the same adapter address" (ContractError::SameAdapter).
  // Filtered before the current-rate lookup below, not after: every
  // configured candidate matching the current adapter means there's nothing
  // to compare regardless of what the current rate turns out to be, so
  // don't pay for that retried lookup only to discover there was never
  // anything to evaluate it against.
  const candidates = Object.entries(config.candidateAdapters).filter(
    ([, adapterId]) => adapterId !== vault.currentAdapterId
  );
  if (candidates.length === 0) {
    return {
      best: null,
      skipReason: "every configured candidate is the vault's current adapter",
    };
  }

  let currentRate: number | null;
  try {
    const result = await withKeeperRetry(
      () =>
        rateSource({
          protocol: vault.currentProtocol,
          adapterId: vault.currentAdapterId,
          poolId: vault.currentPoolId,
          ...(vault.assetId !== undefined && { assetId: vault.assetId }),
        }),
      {
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.baseDelayMs,
        deadlineAt,
      },
      logger,
      {
        vaultId: vault.vaultId,
        adapterId: vault.currentAdapterId,
        protocol: vault.currentProtocol,
        stage: "evaluate",
      },
      sleepFn,
      isTransientKeeperError,
      "migration-keeper"
    );
    currentRate = result.value;
  } catch (err) {
    throw new CandidateEvaluationError(
      vault.currentProtocol,
      vault.currentAdapterId,
      err
    );
  }
  if (!isUsableRate(currentRate)) {
    return { best: null, skipReason: "current rate unavailable" };
  }

  // Evaluated concurrently, like discovery above: each candidate's pool
  // resolution and rate lookup is independent of every other candidate, so
  // running them one at a time would let the deadline budget get eaten by
  // earlier candidates before later ones are even attempted.
  const settled = await Promise.allSettled(
    candidates.map(async ([protocol, adapterId]) => {
      const result = await withKeeperRetry(
        async () => {
          const poolId = await resolveCandidatePool(adapterId);
          return rateSource({
            protocol,
            adapterId,
            poolId,
            ...(vault.assetId !== undefined && { assetId: vault.assetId }),
          });
        },
        {
          maxAttempts: config.maxAttempts,
          baseDelayMs: config.baseDelayMs,
          deadlineAt,
        },
        logger,
        { vaultId: vault.vaultId, adapterId, protocol, stage: "evaluate" },
        sleepFn,
        isTransientKeeperError,
        "migration-keeper"
      );
      return { protocol, adapterId, rate: result.value };
    })
  );

  // A candidate that failed to evaluate must never discard a different
  // candidate that succeeded: an unrelated RPC blip on one protocol
  // shouldn't block a genuine, already-computed migration opportunity on
  // another. Only surface the failure if nothing usable came out of any
  // candidate at all.
  let best: BestCandidate | null = null;
  let firstFailure:
    { protocol: string; adapterId: string; reason: unknown } | undefined;
  let anyRateKnown = false;
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const target = candidates[i];
    if (!outcome || !target) continue;
    const [protocol, adapterId] = target;
    if (outcome.status === "rejected") {
      // Only the first rejection becomes the vault's reported
      // CandidateEvaluationError (KeeperFailure is per-vault, not
      // per-candidate), but every rejection is logged here so a permanent
      // misconfiguration on one candidate isn't invisible just because a
      // different candidate's transient blip happened to be enumerated
      // first.
      logger.warn("[migration-keeper] candidate evaluation failed", {
        vaultId: vault.vaultId,
        adapterId,
        protocol,
        error: errorMessage(outcome.reason),
      });
      firstFailure ??= { protocol, adapterId, reason: outcome.reason };
      continue;
    }
    const { rate } = outcome.value;
    if (!isUsableRate(rate)) continue;
    anyRateKnown = true;

    const improvementBps = rate - currentRate;
    if (improvementBps < config.minImprovementBps) continue;
    if (!best || improvementBps > best.improvementBps) {
      best = { protocol, adapterId, improvementBps };
    }
  }

  if (best) {
    return { best };
  }
  // A failed candidate must never block a valid decision reached from a
  // different candidate, this applies just as much when that decision is
  // "no migration needed" as when it's a winning migration above: if at
  // least one candidate produced a genuine comparison, report that outcome
  // rather than a hard failure, even though a different candidate also
  // failed to evaluate this run (already logged above, per-candidate).
  if (firstFailure && !anyRateKnown) {
    throw new CandidateEvaluationError(
      firstFailure.protocol,
      firstFailure.adapterId,
      firstFailure.reason
    );
  }
  // Distinguishes "compared rates and none cleared the bar" from "no
  // candidate rate was actually known" (e.g. a rate source implemented for
  // one protocol but not another, per #511's phased rollout): the latter
  // never ran a comparison at all, so reporting it as a failed threshold
  // check would mislead anyone reading skipped[] into thinking rates were
  // compared when they weren't.
  return {
    best: null,
    skipReason: anyRateKnown
      ? "no candidate clears the improvement threshold"
      : "no candidate rate was available to compare",
  };
}

async function submitMigrationTransaction(
  vaultContractId: string,
  expectedCurrentAdapterId: string,
  newAdapterId: string,
  maxSlippageBps: number,
  config: MigrationKeeperConfig,
  server: KeeperRpcServer,
  priorHash?: string,
  hooks?: KeeperSubmissionHooks
): Promise<{ hash: string; ledger: number }> {
  // Only checked before building a brand-new transaction, never when
  // rechecking an already-sent one (priorHash set): a cheap, best-effort
  // guard against this run's discovery data being stale because another
  // invocation already migrated this vault since. It also covers the one
  // window the submission record can't (broadcast succeeded, then the
  // process died before the record was written), so the two guards are
  // complementary rather than redundant, see migration-keeper.md.
  if (!priorHash) {
    await assertAdapterUnchanged(
      server,
      vaultContractId,
      config.network.passphrase,
      expectedCurrentAdapterId
    );
  }

  return submitKeeperOperation(
    vaultContractId,
    "migrate_adapter",
    [
      Address.fromString(newAdapterId).toScVal(),
      nativeToScVal(maxSlippageBps, { type: "u32" }),
    ],
    {
      network: config.network,
      secretKey: config.secretKey,
      rpcTimeoutMs: config.rpcTimeoutMs,
      confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS,
    },
    server,
    priorHash,
    hooks
  );
}

export async function runMigrationKeeper(
  config: MigrationKeeperConfig,
  deps: MigrationKeeperDeps = {}
): Promise<MigrationKeeperResult> {
  const logger = deps.logger ?? consoleLogger;
  const sleepFn = deps.sleep ?? sleep;
  const startedAt = new Date().toISOString();
  const deadlineAt = deps.deadlineAt ?? Date.now() + FUNCTION_BUDGET_MS;
  const server = getRpcServer(config.network.rpcUrl, config.rpcTimeoutMs);
  // Shared, not per-run, state: this is the only thing that survives a
  // killed invocation, so it's what stops the next cron tick from sending a
  // second migrate_adapter while the first is still landing (#515).
  const stateStore =
    deps.stateStore ??
    loadKeeperStateStore(process.env, {
      keeper: "migration",
      requireShared: true,
      logger,
    });
  if (deps.submitMigration) {
    logger.warn(
      "[migration-keeper] submitMigration is overridden; cross-invocation dedup depends on the injected submitter forwarding the provided hooks",
      { vaultScope: "all" }
    );
  }
  const rateSource = deps.rateSource ?? createDefaultRateSource(config.network);
  const resolveCandidatePool =
    deps.resolveCandidatePool ??
    (async (adapterId: string) =>
      expectString(
        await simulateView(
          server as never,
          adapterId,
          config.network.passphrase,
          "get_pool"
        ),
        "get_pool",
        adapterId
      ));

  const discovery = deps.discoverVaults
    ? await deps.discoverVaults()
    : await discoverMigrationVaults({
        network: config.network,
        server,
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.baseDelayMs,
        deadlineAt,
        logger,
        sleep: sleepFn,
      });

  const migrations: MigrationSuccess[] = [];
  const skipped: MigrationSkip[] = [];
  const failures: KeeperFailure[] = [...discovery.failures];

  logger.info("[migration-keeper] discovered vaults", {
    network: config.network.network,
    discoveredVaults: discovery.vaults.length,
    discoveryFailures: discovery.failures.length,
  });

  // Sequential for the same reason as the accrual keeper's submission loop:
  // every migrate_adapter call signs and sends from the same admin key, and
  // Stellar requires a strictly increasing sequence number per account.
  for (const vault of discovery.vaults) {
    if (Date.now() >= deadlineAt) {
      failures.push({
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId: vault.currentAdapterId,
        protocol: vault.currentProtocol,
        stage: "submit",
        attempts: 0,
        transient: true,
        error: "Skipped: run deadline reached before this vault could start",
      });
      continue;
    }

    // Checked before evaluation, not just before submission: a vault whose
    // prior migration is still in flight isn't going to be migrated this
    // run either way, so there's no reason to spend the rate lookups (and
    // the deadline budget they consume) reaching that conclusion.
    const stateKey = submissionStateKey(
      "migration",
      config.network.network,
      vault.vaultId
    );
    const priorContext = { vaultId: vault.vaultId, keeper: "migration-keeper" };
    const prior = await resolvePriorSubmission({
      store: stateStore,
      key: stateKey,
      server,
      ttlMs: config.submissionTtlMs,
      rpcTimeoutMs: config.rpcTimeoutMs,
      logger,
      context: priorContext,
    });
    // Every blocking state is fatal for this vault this run: unlike the
    // accrue keeper, this one has no cheap-duplicate escape hatch, so an
    // unverifiable store is a reason to stop, not to guess.
    if (
      prior.state === "in-flight" ||
      prior.state === "claimed" ||
      prior.state === "unknown"
    ) {
      const reason =
        prior.state === "in-flight"
          ? "a prior migrate_adapter submission is still unconfirmed; skipped to avoid a duplicate migration"
          : prior.state === "claimed"
            ? "another run is already preparing a migration for this vault; skipped to avoid a duplicate migration"
            : `prior submission state could not be verified (${prior.reason}); skipped rather than risk a duplicate migration`;
      skipped.push({ vaultId: vault.vaultId, reason });
      logger.warn("[migration-keeper] migration skipped; prior submission", {
        vaultId: vault.vaultId,
        state: prior.state,
        ...(prior.state === "in-flight" && {
          hash: prior.hash,
          ageMs: prior.ageMs,
        }),
      });
      continue;
    }
    if (prior.state !== "none") {
      // landed / failed / expired: the record is already cleared, this run
      // is free to evaluate again. Logged because "the previous run's
      // transaction turned out to have landed after all" is exactly the
      // sequence that's impossible to reconstruct afterwards otherwise.
      logger.info("[migration-keeper] prior submission resolved", {
        vaultId: vault.vaultId,
        state: prior.state,
        hash: prior.hash,
      });
    }

    let evaluation: { best: BestCandidate | null; skipReason?: string };
    try {
      evaluation = await findBestCandidate(
        vault,
        config,
        rateSource,
        resolveCandidatePool,
        logger,
        sleepFn,
        deadlineAt
      );
    } catch (err) {
      const { adapterId, protocol, attempts, transient } =
        err instanceof CandidateEvaluationError
          ? err
          : {
              adapterId: vault.currentAdapterId,
              protocol: vault.currentProtocol,
              attempts: 1,
              transient: isTransientKeeperError(err),
            };
      failures.push({
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId,
        protocol,
        stage: "evaluate",
        attempts,
        transient,
        error: redactedErrorMessage(err),
      });
      continue;
    }

    if (!evaluation.best) {
      skipped.push({
        vaultId: vault.vaultId,
        reason: evaluation.skipReason ?? "no migration needed",
      });
      continue;
    }

    const { best } = evaluation;

    // Re-checked here, not just at the top of the loop: evaluation itself
    // can retry and consume most of the budget, and this is an
    // irreversible, slippage-costing transaction, not a cheap read. Firing
    // it just as the platform is about to kill the invocation is worse
    // than skipping it for this run. Reports best's adapter/protocol, not
    // the vault's current one, unlike the top-of-loop check above: best is
    // already known here, and it's the migration that's actually being
    // skipped.
    if (Date.now() >= deadlineAt) {
      failures.push({
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId: best.adapterId,
        protocol: best.protocol,
        stage: "submit",
        attempts: 0,
        transient: true,
        error:
          "Skipped: run deadline reached after evaluation, before submission could start",
      });
      continue;
    }
    // Taken before anything is built: a plain "no record" read is not a
    // claim on the vault, so two concurrent invocations could otherwise both
    // pass the check above and both broadcast.
    const acquired = await SubmissionLease.acquire({
      store: stateStore,
      key: stateKey,
      submissionTtlMs: config.submissionTtlMs,
      logger,
      context: priorContext,
    });
    if ("error" in acquired) {
      skipped.push({
        vaultId: vault.vaultId,
        reason: `could not take the submission lease (${acquired.error}); skipped rather than risk a duplicate migration`,
      });
      continue;
    }
    const lease = acquired.lease;
    const submissionHooks = lease.hooks;

    // migrate_adapter (#567) now requires an active begin_migration
    // snapshot for the same target adapter, at least MIN_LEDGER_GAP
    // ledgers old. Rather than duplicate the contract's ledger-gap math
    // here, this only checks whether a matching snapshot exists; if the
    // cooldown hasn't elapsed yet, the contract itself rejects the call
    // with MigrationCooldownNotMet during simulation (no fee, nothing
    // sent), which falls through to the existing failure handling below
    // and is retried on a later run — comfortably fine given
    // MIN_LEDGER_GAP is ~1 minute and this keeper runs far less often
    // than that.
    //
    // Skipped entirely when deps.submitMigration is injected: that's a
    // full override of the on-chain submission mechanism (see its use
    // below), and this on-chain precheck would otherwise reach the real
    // network/mocks regardless of the injected override, same as
    // assertAdapterUnchanged inside submitMigrationTransaction only runs
    // on the real path.
    let hasMatchingSnapshot = deps.submitMigration != null;
    let snapshotReadFailed = false;
    if (!hasMatchingSnapshot) {
      try {
        const snapshot = (await simulateView(
          server as never,
          vault.vaultContractId,
          config.network.passphrase,
          "get_migration_snapshot"
        )) as { adapter: string } | null;
        hasMatchingSnapshot = snapshot?.adapter === best.adapterId;
      } catch (err) {
        // A genuine "no snapshot" (or one for a different adapter) traps
        // with MigrationNotInitialized, which is not a transient failure by
        // isTransientKeeperError's classification — that's the case this
        // falls through to begin_migration for. A real RPC/network failure
        // reading the snapshot must NOT be treated the same way: assuming
        // "no snapshot" and firing begin_migration would reset a possibly
        // already cooldown-elapsed snapshot's ledger_seq back to now,
        // pushing a ready-to-migrate vault's migration back a full
        // MIN_LEDGER_GAP for no reason. Report it as a retryable failure
        // instead, same as this file's other on-chain read checks.
        hasMatchingSnapshot = false;
        snapshotReadFailed = isTransientKeeperError(err);
      }
    }

    if (snapshotReadFailed) {
      failures.push({
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId: best.adapterId,
        protocol: best.protocol,
        stage: "submit",
        attempts: 1,
        transient: true,
        error:
          "could not read the migration snapshot; skipped rather than risk resetting an existing cooldown",
      });
      await lease.releaseIfUnsent();
      continue;
    }

    if (!hasMatchingSnapshot) {
      try {
        await submitKeeperOperation(
          vault.vaultContractId,
          "begin_migration",
          [Address.fromString(best.adapterId).toScVal()],
          {
            network: config.network,
            secretKey: config.secretKey,
            rpcTimeoutMs: config.rpcTimeoutMs,
            confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS,
          },
          server
        );
        logger.info(
          "[migration-keeper] begin_migration submitted; migrate_adapter deferred to a later run once the ledger-gap cooldown elapses",
          {
            vaultId: vault.vaultId,
            toAdapterId: best.adapterId,
            toProtocol: best.protocol,
          }
        );
        skipped.push({
          vaultId: vault.vaultId,
          reason:
            "begin_migration submitted; waiting for the ledger-gap cooldown before migrate_adapter",
        });
      } catch (err) {
        failures.push({
          vaultId: vault.vaultId,
          vaultContractId: vault.vaultContractId,
          adapterId: best.adapterId,
          protocol: best.protocol,
          stage: "submit",
          attempts: 1,
          transient: isTransientKeeperError(err),
          error: redactedErrorMessage(err),
        });
      }
      await lease.releaseIfUnsent();
      continue;
    }

    let priorHash: string | undefined;
    try {
      const result = await withKeeperRetry(
        (attempt) =>
          deps.submitMigration
            ? deps.submitMigration(
                vault,
                best.adapterId,
                attempt,
                submissionHooks
              )
            : submitMigrationTransaction(
                vault.vaultContractId,
                vault.currentAdapterId,
                best.adapterId,
                config.maxSlippageBps,
                config,
                server,
                priorHash,
                submissionHooks
              ).catch((err: unknown) => {
                if (err instanceof SubmissionInFlightError) {
                  priorHash = err.sentHash;
                }
                throw err;
              }),
        {
          maxAttempts: config.maxAttempts,
          baseDelayMs: config.baseDelayMs,
          deadlineAt,
        },
        logger,
        {
          vaultId: vault.vaultId,
          fromAdapterId: vault.currentAdapterId,
          toAdapterId: best.adapterId,
          toProtocol: best.protocol,
        },
        sleepFn,
        isTransientKeeperError,
        "migration-keeper"
      );
      migrations.push({
        vaultId: vault.vaultId,
        fromAdapterId: vault.currentAdapterId,
        fromProtocol: vault.currentProtocol,
        toAdapterId: best.adapterId,
        toProtocol: best.protocol,
        improvementBps: best.improvementBps,
        hash: result.value.hash,
        ledger: result.value.ledger,
        attempts: result.attempts,
      });
      logger.info("[migration-keeper] migrate_adapter submitted", {
        vaultId: vault.vaultId,
        toAdapterId: best.adapterId,
        toProtocol: best.protocol,
        improvementBps: best.improvementBps,
        hash: result.value.hash,
        ledger: result.value.ledger,
        attempts: result.attempts,
      });
    } catch (err) {
      if (isStaleAdapterError(err)) {
        // A static, address-free reason, not redactedErrorMessage(err):
        // the underlying message embeds two full C-addresses, which with
        // real (56-char) Stellar addresses would trip sanitizeTxError's
        // redaction and fall back to a generic "Keeper operation failed",
        // discarding the one useful thing to tell an API consumer here
        // (why the migration was skipped) for no security benefit, adapter
        // addresses aren't secret. Full detail (with addresses) still goes
        // to the log below, server-side only.
        skipped.push({
          vaultId: vault.vaultId,
          reason:
            "vault's adapter changed since discovery; skipped to avoid a stale migration",
        });
        logger.info(
          "[migration-keeper] migration skipped; adapter changed since discovery",
          {
            vaultId: vault.vaultId,
            detail: errorMessage(err),
          }
        );
        continue;
      }
      const { attempts, transient } = retryOutcome(err, isTransientKeeperError);
      const failure: KeeperFailure = {
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId: best.adapterId,
        protocol: best.protocol,
        stage: "submit",
        attempts,
        transient,
        error: redactedErrorMessage(err),
      };
      failures.push(failure);
      logger.error("[migration-keeper] migrate_adapter failed", { ...failure });
    } finally {
      // A claim that never became a signed transaction (stale adapter, a
      // simulation error, an exhausted deadline) must not keep the next run
      // out for the claim's full window.
      await lease.releaseIfUnsent();
    }
  }

  return {
    network: config.network.network,
    startedAt,
    finishedAt: new Date().toISOString(),
    discoveredVaults: discovery.vaults.length,
    migrations,
    skipped,
    failures,
  };
}
