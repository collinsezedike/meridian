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
// source always reports "unknown" and the keeper never migrates until a
// real one is injected. This mirrors the accrual keeper's own shape
// (discovery, retry, structured failure reporting, deadline budget); see
// accrual-keeper.ts.

import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { APP_ADDRESSES, APP_NETWORK } from "@meridian/shared";
import { KNOWN_POOLS, type KnownPoolMeta } from "./known-pools";
import { getRpcServer } from "./internal";
import { simulateView } from "./tx";
import type { StellarNetwork } from "./types";
import {
  consoleLogger,
  errorMessage,
  retryOutcome,
  sleep,
  withKeeperRetry,
  type KeeperFailure,
  type KeeperLogger,
} from "./keeper-retry";
import {
  expectString,
  rawErrorText,
  submitKeeperOperation,
  SubmissionFailedError,
  SubmissionInFlightError,
  type KeeperRpcServer,
} from "./keeper-tx";

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

export type CandidateProtocol = "blend" | "defindex";

export interface RateQuery {
  protocol: CandidateProtocol;
  adapterId: string;
  poolId: string;
}

/**
 * Returns a comparable annualized rate in basis points for the given
 * adapter/pool, or null when it can't be determined. Pluggable because
 * neither Blend nor DeFindex exposes a ready-made comparable rate today:
 * Blend's adapter only exposes the raw inputs to its own kinked interest
 * rate curve, not a computed rate, and DeFindex's share price needs a
 * second sample over time to derive one. Implementing either is separate,
 * dedicated follow-up work; the default here always returns null, so the
 * keeper never migrates until a real source is injected.
 */
export type RateSourceFn = (query: RateQuery) => Promise<number | null>;

const defaultRateSource: RateSourceFn = async () => null;

export interface MigrationKeeperConfig {
  network: StellarNetwork;
  secretKey: string;
  maxAttempts: number;
  baseDelayMs: number;
  rpcTimeoutMs: number;
  minImprovementBps: number;
  maxSlippageBps: number;
  candidateAdapters: Partial<Record<CandidateProtocol, string>>;
}

export interface DiscoveredVault {
  vaultId: string;
  vaultContractId: string;
  currentAdapterId: string;
  currentProtocol: string;
  currentPoolId: string;
}

export interface MigrationSuccess {
  vaultId: string;
  fromAdapterId: string;
  fromProtocol: string;
  toAdapterId: string;
  toProtocol: CandidateProtocol;
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

interface RetryTuning {
  maxAttempts: number;
  baseDelayMs: number;
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
  submitMigration?: (
    vault: DiscoveredVault,
    toAdapterId: string,
    attempt: number
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
  logger?: KeeperLogger;
  sleep?: (ms: number) => Promise<void>;
  deadlineAt?: number;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
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
    candidateAdapters: {
      ...(env.MERIDIAN_BLEND_ADAPTER_ID?.trim() && {
        blend: env.MERIDIAN_BLEND_ADAPTER_ID.trim(),
      }),
      ...((env.MERIDIAN_DEFINDEX_ADAPTER_ID?.trim() ||
        APP_ADDRESSES.defindex.adapter) && {
        defindex:
          env.MERIDIAN_DEFINDEX_ADAPTER_ID?.trim() ||
          APP_ADDRESSES.defindex.adapter,
      }),
    },
  };
}

function isTransientMigrationError(err: unknown): boolean {
  if (err instanceof SubmissionFailedError) return false;
  if (err instanceof SubmissionInFlightError) return true;
  const message = rawErrorText(err).toLowerCase();
  return (
    message.includes("try again") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("temporarily") ||
    /\b(429|500|502|503|504)\b/.test(message)
  );
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
  const retryConfig: RetryTuning & { deadlineAt?: number } = {
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
      return withKeeperRetry(
        async () => {
          const currentAdapterId = expectString(
            await simulate(
              server as never,
              vaultContractId,
              network.passphrase,
              "get_adapter"
            ),
            "get_adapter",
            vaultContractId
          );
          const currentProtocol = expectString(
            await simulate(
              server as never,
              currentAdapterId,
              network.passphrase,
              "get_protocol"
            ),
            "get_protocol",
            currentAdapterId
          );
          const currentPoolId = expectString(
            await simulate(
              server as never,
              currentAdapterId,
              network.passphrase,
              "get_pool"
            ),
            "get_pool",
            currentAdapterId
          );
          return {
            vaultId: meta.id,
            vaultContractId,
            currentAdapterId,
            currentProtocol,
            currentPoolId,
          };
        },
        retryConfig,
        logger,
        { vaultId: meta.id, vaultContractId, stage: "discover" },
        sleepFn,
        isTransientMigrationError,
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
    const { attempts, transient } = retryOutcome(
      err,
      isTransientMigrationError
    );
    failures.push({
      vaultId: meta.id,
      vaultContractId,
      stage: "discover",
      attempts,
      transient,
      error: errorMessage(err),
    });
  }

  return { vaults, failures };
}

interface BestCandidate {
  protocol: CandidateProtocol;
  adapterId: string;
  improvementBps: number;
}

async function findBestCandidate(
  vault: DiscoveredVault,
  config: MigrationKeeperConfig,
  rateSource: RateSourceFn,
  resolveCandidatePool: (adapterId: string) => Promise<string>
): Promise<{ best: BestCandidate | null; skipReason?: string }> {
  const currentRate = await rateSource({
    protocol: vault.currentProtocol as CandidateProtocol,
    adapterId: vault.currentAdapterId,
    poolId: vault.currentPoolId,
  });
  if (currentRate === null) {
    return { best: null, skipReason: "current rate unavailable" };
  }

  let best: BestCandidate | null = null;
  for (const [protocol, adapterId] of Object.entries(
    config.candidateAdapters
  ) as [CandidateProtocol, string | undefined][]) {
    if (!adapterId) continue;
    if (adapterId === vault.currentAdapterId) continue;
    if (protocol === vault.currentProtocol) continue;

    const poolId = await resolveCandidatePool(adapterId);
    const candidateRate = await rateSource({ protocol, adapterId, poolId });
    if (candidateRate === null) continue;

    const improvementBps = candidateRate - currentRate;
    if (improvementBps < config.minImprovementBps) continue;
    if (!best || improvementBps > best.improvementBps) {
      best = { protocol, adapterId, improvementBps };
    }
  }

  if (!best) {
    return {
      best: null,
      skipReason: "no candidate clears the improvement threshold",
    };
  }
  return { best };
}

function submitMigrationTransaction(
  vaultContractId: string,
  newAdapterId: string,
  maxSlippageBps: number,
  config: MigrationKeeperConfig,
  server: KeeperRpcServer,
  priorHash?: string
): Promise<{ hash: string; ledger: number }> {
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
    priorHash
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
  const rateSource = deps.rateSource ?? defaultRateSource;
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
        stage: "submit",
        attempts: 0,
        transient: true,
        error: "Skipped: run deadline reached before this vault could start",
      });
      continue;
    }

    let evaluation: { best: BestCandidate | null; skipReason?: string };
    try {
      evaluation = await findBestCandidate(
        vault,
        config,
        rateSource,
        resolveCandidatePool
      );
    } catch (err) {
      failures.push({
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId: vault.currentAdapterId,
        protocol: vault.currentProtocol,
        stage: "discover",
        attempts: 1,
        transient: isTransientMigrationError(err),
        error: errorMessage(err),
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
    let priorHash: string | undefined;
    try {
      const result = await withKeeperRetry(
        (attempt) =>
          deps.submitMigration
            ? deps.submitMigration(vault, best.adapterId, attempt)
            : submitMigrationTransaction(
                vault.vaultContractId,
                best.adapterId,
                config.maxSlippageBps,
                config,
                server,
                priorHash
              ).catch((err: unknown) => {
                if (err instanceof SubmissionInFlightError) {
                  priorHash = err.sentHash;
                }
                throw err;
              }),
        { ...config, deadlineAt },
        logger,
        {
          vaultId: vault.vaultId,
          fromAdapterId: vault.currentAdapterId,
          toAdapterId: best.adapterId,
          toProtocol: best.protocol,
        },
        sleepFn,
        isTransientMigrationError,
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
      const { attempts, transient } = retryOutcome(
        err,
        isTransientMigrationError
      );
      const failure: KeeperFailure = {
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId: best.adapterId,
        protocol: best.protocol,
        stage: "submit",
        attempts,
        transient,
        error: errorMessage(err),
      };
      failures.push(failure);
      logger.error("[migration-keeper] migrate_adapter failed", { ...failure });
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
