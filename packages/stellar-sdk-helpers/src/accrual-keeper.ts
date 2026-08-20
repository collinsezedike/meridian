import { APP_NETWORK } from "@meridian/shared";
import { KNOWN_POOLS, type KnownPoolMeta } from "./known-pools";
import { getRpcServer } from "./internal";
import { simulateView } from "./tx";
import type { StellarNetwork } from "./types";
import {
  consoleLogger,
  parsePositiveInt,
  redactedErrorMessage,
  retryOutcome,
  sleep,
  withKeeperRetry,
  type KeeperFailure,
  type KeeperLogger,
} from "./keeper-retry";
import {
  expectString,
  isTransientKeeperError,
  submitKeeperOperation,
  SubmissionInFlightError,
  type KeeperRpcServer,
} from "./keeper-tx";

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
  submitAccrual?: (
    adapter: DiscoveredAdapter,
    attempt: number
  ) => Promise<Omit<AccrualSuccess, "attempts" | "vaultId" | "adapterId">>;
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

function submitAccrualTransaction(
  adapter: DiscoveredAdapter,
  config: BlendAccrualKeeperConfig,
  server: KeeperRpcServer,
  priorHash?: string
): Promise<Omit<AccrualSuccess, "attempts" | "vaultId" | "adapterId">> {
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
    priorHash
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
    // Scoped to this run only: an unconfirmed hash from a prior invocation
    // (e.g. the previous cron tick) is not recoverable here, so a run that
    // exhausts its retries mid-confirmation can send a fresh accrue() next
    // time. Accepted: accrue() only refreshes a cached value from live
    // on-chain state, so a duplicate costs a wasted fee, not bad accounting.
    let priorHash: string | undefined;
    try {
      const result = await withKeeperRetry(
        (attempt) =>
          deps.submitAccrual
            ? deps.submitAccrual(adapter, attempt)
            : submitAccrualTransaction(
                adapter,
                config,
                server,
                priorHash
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
