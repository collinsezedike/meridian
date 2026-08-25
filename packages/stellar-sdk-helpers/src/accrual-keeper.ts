import { APP_NETWORK } from "@meridian/shared";
import { KNOWN_POOLS, type KnownPoolMeta } from "./known-pools";
import { getRpcServer } from "./internal";
import { simulateView } from "./tx";
import type { StellarNetwork } from "./types";
import {
  consoleLogger,
  errorMessage,
  parsePositiveInt,
  redactedErrorMessage,
  retryOutcome,
  sleep,
  withKeeperRetry,
  type KeeperFailure,
  type KeeperLogger,
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

export type { KeeperFailure, KeeperLogger } from "./keeper-retry";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
// Capped at 10_000 to match tx.ts's own hardcoded Soroban RPC timeout
// (SOROBAN_RPC_TIMEOUT_MS): discovery's simulate() calls go through
// simulateView, which races every call against that fixed 10s ceiling
// regardless of what's configured here. Submission-side calls in
// submitAccrualTransaction use config.rpcTimeoutMs directly via
// withRaceTimeout and are not subject to this cap, only discovery is.
// A configured MERIDIAN_KEEPER_RPC_TIMEOUT_MS above 10_000 still fully
// governs submission; it's silently capped at 10s for discovery only.
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

// Deliberately separate from rpcTimeoutMs: confirmation waits for a Stellar
// ledger to close and record the transaction, not a bounded API call.
// Ledgers close roughly every 5s, and confirmation typically needs 2-4
// closes (10-20s), so reusing the short RPC-call timeout here (as an
// earlier version of this file did) made the confirmation wait time out
// under ordinary network conditions, not just outages, which is exactly
// what made the double-submission bug below reachable in normal operation.
const CONFIRMATION_TIMEOUT_MS = 20_000;

// Vercel Hobby tier hard-caps this endpoint at 60s (see vercel.json's
// functions."api/v1/keepers/accrue.ts".maxDuration). maxAttempts=3 retries
// through CONFIRMATION_TIMEOUT_MS=20s waits alone can exceed 60s for a
// single adapter, before discovery or a second adapter are even counted; a
// platform-killed invocation returns no structured response and forgets the
// in-run duplicate-submission tracking above. Budgeted below maxDuration so
// the run can instead stop starting new work and return a clean partial
// result while there's still time left to do so.
const FUNCTION_BUDGET_MS = 50_000;

export interface BlendAccrualKeeperConfig {
  network: StellarNetwork;
  secretKey: string;
  maxAttempts: number;
  baseDelayMs: number;
  rpcTimeoutMs: number;
  submissionTtlMs: number;
}

export interface DiscoveredAdapter {
  vaultId: string;
  vaultContractId: string;
  adapterId: string;
  protocol: string;
}

export interface AccrualSuccess {
  vaultId: string;
  adapterId: string;
  hash: string;
  ledger: number;
  attempts: number;
}

export interface SkippedAdapter {
  vaultId: string;
  vaultContractId: string;
  adapterId: string;
  protocol: string;
  // Names the actual protocol that was skipped, not a fixed literal: once a
  // second non-Blend protocol is discoverable, every skip reporting the same
  // hardcoded string would be indistinguishable from each other.
  reason: string;
}

export interface BlendAccrualKeeperResult {
  network: StellarNetwork["network"];
  startedAt: string;
  finishedAt: string;
  discoveredAdapters: number;
  blendAdapters: number;
  successes: AccrualSuccess[];
  skipped: SkippedAdapter[];
  failures: KeeperFailure[];
}

type SimulateFn = typeof simulateView;

export interface DiscoverAdaptersOptions {
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

export interface BlendAccrualKeeperDeps {
  discoverAdapters?: () => Promise<{
    adapters: DiscoveredAdapter[];
    failures: KeeperFailure[];
  }>;
  // `hooks` carries this run's submission lease: an override that forwards
  // it to submitKeeperOperation keeps cross-invocation dedup; one that
  // ignores it falls back to the claim held for the duration of the run, and
  // is warned about at run start.
  submitAccrual?: (
    adapter: DiscoveredAdapter,
    attempt: number,
    hooks: KeeperSubmissionHooks
  ) => Promise<Omit<AccrualSuccess, "attempts" | "vaultId" | "adapterId">>;
  // Cross-invocation submission tracking (#515). Defaults to whatever the
  // environment provides (Upstash Redis when configured); injected in tests.
  stateStore?: KeeperStateStore;
  logger?: KeeperLogger;
  sleep?: (ms: number) => Promise<void>;
  deadlineAt?: number;
}

export function loadBlendAccrualKeeperConfig(
  env: Record<string, string | undefined>
): BlendAccrualKeeperConfig {
  const secretKey =
    env.MERIDIAN_KEEPER_SECRET_KEY?.trim() || env.KEEPER_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("MERIDIAN_KEEPER_SECRET_KEY is required");
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
    submissionTtlMs: parseSubmissionTtlMs(env),
  };
}

export async function discoverLiveAdapters(
  options: DiscoverAdaptersOptions = {}
): Promise<{ adapters: DiscoveredAdapter[]; failures: KeeperFailure[] }> {
  const network = options.network ?? APP_NETWORK;
  const networkKey = network.network === "mainnet" ? "mainnet" : "testnet";
  const pools = options.pools ?? KNOWN_POOLS[networkKey];
  const server =
    options.server ?? getRpcServer(network.rpcUrl, DEFAULT_RPC_TIMEOUT_MS);
  const simulate = options.simulate ?? simulateView;
  const logger = options.logger ?? consoleLogger;
  const sleepFn = options.sleep ?? sleep;
  const retryConfig = {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    ...(options.deadlineAt !== undefined && { deadlineAt: options.deadlineAt }),
  };
  const targets = Object.values(pools).filter(
    (meta) => meta.protocol === "meridian" && meta.contractId
  );

  // Vaults are independent of each other, so discover them concurrently
  // rather than one at a time: sequential discovery means total wall-clock
  // time is the sum of every vault's worst case (each with its own retry
  // budget), which risks exceeding the keeper's function time limit as more
  // vaults come online. Concurrent discovery bounds total time to the
  // slowest single vault instead.
  const settled = await Promise.allSettled(
    targets.map((meta) => {
      const vaultContractId = meta.contractId as string;
      // Cached across this target's own retry attempts (not shared with any
      // other target): a transient failure on get_protocol used to also
      // re-issue an already-succeeded get_adapter call on retry, since both
      // lived in the same combined closure. Caching whatever already
      // succeeded means a retry only re-issues the call that actually failed.
      let adapterId: string | undefined;
      return withKeeperRetry(
        async () => {
          adapterId ??= expectString(
            await simulate(
              server as never,
              vaultContractId,
              network.passphrase,
              "get_adapter"
            ),
            "get_adapter",
            vaultContractId
          );
          const protocol = expectString(
            await simulate(
              server as never,
              adapterId,
              network.passphrase,
              "get_protocol"
            ),
            "get_protocol",
            adapterId
          );
          return {
            vaultId: meta.id,
            vaultContractId,
            adapterId,
            protocol,
          };
        },
        retryConfig,
        logger,
        {
          vaultId: meta.id,
          vaultContractId,
          stage: "discover",
        },
        sleepFn,
        isTransientKeeperError,
        "accrual-keeper"
      );
    })
  );

  const adapters: DiscoveredAdapter[] = [];
  const failures: KeeperFailure[] = [];

  const pairs = targets.map((meta, i) => ({ meta, outcome: settled[i] }));

  for (const { meta, outcome } of pairs) {
    if (!outcome) continue;
    const vaultContractId = meta.contractId as string;
    if (outcome.status === "fulfilled") {
      adapters.push(outcome.value.value);
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

  return { adapters, failures };
}

async function submitAccrualTransaction(
  adapter: DiscoveredAdapter,
  config: BlendAccrualKeeperConfig,
  server: KeeperRpcServer,
  priorHash?: string,
  hooks?: KeeperSubmissionHooks
): Promise<Omit<AccrualSuccess, "attempts" | "vaultId" | "adapterId">> {
  // The accrue and migration keepers act on the same vault's adapter with no
  // coordination between them: this keeper can read get_adapter() at
  // discovery, have the migration keeper switch the vault to a different
  // adapter before this submission lands, and then accrue() the detached
  // one, a silently ineffective call (a detached adapter is still a valid
  // contract, so nothing errors) whose yield never reaches the vault.
  // Re-reading the vault's live adapter here is the same guard the migration
  // keeper already runs before building its own transaction. Skipped when
  // rechecking an already-sent transaction (priorHash), which must keep
  // tracking that hash rather than re-deciding whether to send it.
  if (!priorHash) {
    await assertAdapterUnchanged(
      server,
      adapter.vaultContractId,
      config.network.passphrase,
      adapter.adapterId
    );
  }

  return submitKeeperOperation(
    adapter.adapterId,
    "accrue",
    [],
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

export async function runBlendAccrualKeeper(
  config: BlendAccrualKeeperConfig,
  deps: BlendAccrualKeeperDeps = {}
): Promise<BlendAccrualKeeperResult> {
  const logger = deps.logger ?? consoleLogger;
  const sleepFn = deps.sleep ?? sleep;
  const startedAt = new Date().toISOString();
  const deadlineAt = deps.deadlineAt ?? Date.now() + FUNCTION_BUDGET_MS;
  const server = getRpcServer(config.network.rpcUrl, config.rpcTimeoutMs);
  // Same mechanism as the migration keeper's, deliberately: a duplicate
  // accrue() only costs a wasted fee, but having both keepers behave
  // identically is what makes the execution model reasonable to audit. The
  // one difference is the fallback, see loadKeeperStateStore's requireShared.
  const stateStore =
    deps.stateStore ??
    loadKeeperStateStore(process.env, {
      keeper: "accrual",
      requireShared: false,
      logger,
    });
  if (deps.submitAccrual) {
    logger.warn(
      "[accrual-keeper] submitAccrual is overridden; cross-invocation dedup depends on the injected submitter forwarding the provided hooks"
    );
  }
  const discovery = deps.discoverAdapters
    ? await deps.discoverAdapters()
    : await discoverLiveAdapters({
        network: config.network,
        server,
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.baseDelayMs,
        deadlineAt,
        logger,
        sleep: sleepFn,
      });
  const successes: AccrualSuccess[] = [];
  const failures: KeeperFailure[] = [...discovery.failures];
  const skipped: SkippedAdapter[] = [];
  const blendAdapters = discovery.adapters.filter((adapter) => {
    if (adapter.protocol === "blend") return true;
    skipped.push({
      ...adapter,
      reason: `non-blend (protocol: ${adapter.protocol})`,
    });
    return false;
  });

  logger.info("[accrual-keeper] discovered adapters", {
    network: config.network.network,
    discoveredAdapters: discovery.adapters.length,
    blendAdapters: blendAdapters.length,
    skippedAdapters: skipped.length,
    discoveryFailures: discovery.failures.length,
  });

  // Deliberately sequential, unlike discovery above: every submission signs
  // and sends from the same keeper account (config.secretKey), and Stellar
  // requires a strictly increasing sequence number per account. Running
  // these concurrently would have multiple submissions racing for the same
  // sequence number and mostly failing, not a performance win.
  for (const adapter of blendAdapters) {
    // Sequential processing means each unstarted adapter's cost compounds on
    // top of the ones before it; stop starting new submissions once the
    // deadline has already passed rather than risk the platform killing the
    // invocation mid-retry, which would lose this response entirely.
    if (Date.now() >= deadlineAt) {
      failures.push({
        vaultId: adapter.vaultId,
        vaultContractId: adapter.vaultContractId,
        adapterId: adapter.adapterId,
        protocol: adapter.protocol,
        stage: "submit",
        attempts: 0,
        transient: true,
        error: "Skipped: run deadline reached before this adapter could start",
      });
      logger.warn("[accrual-keeper] skipping adapter; run deadline reached", {
        vaultId: adapter.vaultId,
        adapterId: adapter.adapterId,
      });
      continue;
    }
    // Resolved against the network, never trusted from the record alone: a
    // hash that landed (or failed, or aged past the transaction's validity
    // window) clears and lets this run proceed; only a genuinely still-in-
    // flight one blocks. See keeper-state.ts.
    const stateKey = submissionStateKey(
      "accrual",
      config.network.network,
      adapter.vaultId,
      adapter.adapterId
    );
    const priorContext = {
      vaultId: adapter.vaultId,
      adapterId: adapter.adapterId,
    };
    const prior = await resolvePriorSubmission({
      store: stateStore,
      key: stateKey,
      server,
      ttlMs: config.submissionTtlMs,
      rpcTimeoutMs: config.rpcTimeoutMs,
      logger,
      context: priorContext,
    });
    if (prior.state === "in-flight" || prior.state === "claimed") {
      skipped.push({
        vaultId: adapter.vaultId,
        vaultContractId: adapter.vaultContractId,
        adapterId: adapter.adapterId,
        protocol: adapter.protocol,
        reason:
          prior.state === "in-flight"
            ? "a prior accrue() submission is still unconfirmed; skipped to avoid a duplicate"
            : "another run is already preparing an accrue() for this adapter; skipped to avoid a duplicate",
      });
      logger.warn("[accrual-keeper] skipping adapter; prior submission", {
        vaultId: adapter.vaultId,
        adapterId: adapter.adapterId,
        state: prior.state,
      });
      continue;
    }
    if (prior.state === "unknown") {
      // Deliberately fail *open* here, unlike the migration keeper: halting
      // all accrual for the length of a store outage would leave every
      // vault's TVL/APY stale, which is worse than the duplicate it avoids.
      // A duplicate accrue() re-syncs a cached value from live state and
      // costs one Soroban fee. The migration keeper's duplicate costs
      // slippage twice, which is why only it stops.
      logger.warn(
        "[accrual-keeper] proceeding without cross-invocation dedup; prior submission state unknown",
        { ...priorContext, reason: prior.reason }
      );
    }

    // Taken before anything is built, so two concurrent invocations can't
    // both read "no record" and both broadcast.
    const acquired = await SubmissionLease.acquire({
      store: stateStore,
      key: stateKey,
      submissionTtlMs: config.submissionTtlMs,
      logger,
      context: priorContext,
    });
    if ("error" in acquired) {
      skipped.push({
        vaultId: adapter.vaultId,
        vaultContractId: adapter.vaultContractId,
        adapterId: adapter.adapterId,
        protocol: adapter.protocol,
        reason: `could not take the submission lease (${acquired.error}); skipped this run`,
      });
      continue;
    }
    const lease = acquired.lease;
    const submissionHooks = lease.hooks;

    // In-run tracking (priorHash) still exists alongside the lease: it's
    // what keeps a retry inside this same run rechecking one hash instead of
    // re-reading the store on every attempt.
    let priorHash: string | undefined;
    try {
      const result = await withKeeperRetry(
        (attempt) =>
          deps.submitAccrual
            ? deps.submitAccrual(adapter, attempt, submissionHooks)
            : submitAccrualTransaction(
                adapter,
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
          vaultId: adapter.vaultId,
          adapterId: adapter.adapterId,
          protocol: adapter.protocol,
        },
        sleepFn,
        isTransientKeeperError,
        "accrual-keeper"
      );
      successes.push({
        vaultId: adapter.vaultId,
        adapterId: adapter.adapterId,
        hash: result.value.hash,
        ledger: result.value.ledger,
        attempts: result.attempts,
      });
      logger.info("[accrual-keeper] accrue submitted", {
        vaultId: adapter.vaultId,
        adapterId: adapter.adapterId,
        hash: result.value.hash,
        ledger: result.value.ledger,
        attempts: result.attempts,
      });
    } catch (err) {
      if (isStaleAdapterError(err)) {
        // The migration keeper moved this vault to a different adapter while
        // this run was working. Accruing the detached one would succeed and
        // do nothing useful; the new adapter gets picked up by the next run's
        // discovery. A benign race, so a skip rather than a failure that
        // would page someone.
        skipped.push({
          vaultId: adapter.vaultId,
          vaultContractId: adapter.vaultContractId,
          adapterId: adapter.adapterId,
          protocol: adapter.protocol,
          reason:
            "vault's adapter changed since discovery; skipped to avoid accruing a detached adapter",
        });
        logger.info(
          "[accrual-keeper] accrue skipped; adapter changed since discovery",
          {
            vaultId: adapter.vaultId,
            adapterId: adapter.adapterId,
            detail: errorMessage(err),
          }
        );
        continue;
      }
      const { attempts, transient } = retryOutcome(err, isTransientKeeperError);
      const failure: KeeperFailure = {
        vaultId: adapter.vaultId,
        vaultContractId: adapter.vaultContractId,
        adapterId: adapter.adapterId,
        protocol: adapter.protocol,
        stage: "submit",
        attempts,
        transient,
        error: redactedErrorMessage(err),
      };
      failures.push(failure);
      logger.error("[accrual-keeper] accrue failed", { ...failure });
    } finally {
      // A claim that never became a signed transaction (a stale adapter, a
      // simulation error) must not keep the next run out for the claim's
      // full window.
      await lease.releaseIfUnsent();
    }
  }

  return {
    network: config.network.network,
    startedAt,
    finishedAt: new Date().toISOString(),
    discoveredAdapters: discovery.adapters.length,
    blendAdapters: blendAdapters.length,
    successes,
    skipped,
    failures,
  };
}
