import {
  Account,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { APP_NETWORK, withRaceTimeout } from "@meridian/shared";
import { KNOWN_POOLS, type KnownPoolMeta } from "./known-pools";
import { BASE_FEE, getRpcServer } from "./internal";
import { simulateView, simErrorMessage, waitForTransaction } from "./tx";
import type { StellarNetwork } from "./types";

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

export interface KeeperFailure {
  vaultId?: string;
  vaultContractId?: string;
  adapterId?: string;
  protocol?: string;
  stage: "discover" | "submit";
  attempts: number;
  transient: boolean;
  error: string;
}

export interface SkippedAdapter {
  vaultId: string;
  vaultContractId: string;
  adapterId: string;
  protocol: string;
  reason: "non-blend";
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

export interface KeeperLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  deadlineAt?: number;
}

interface KeeperRpcServer {
  getAccount(publicKey: string): Promise<Account>;
  simulateTransaction(
    tx: Transaction
  ): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
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

const consoleLogger: KeeperLogger = {
  info(message, context) {
    console.info(message, context ?? {});
  },
  warn(message, context) {
    console.warn(message, context ?? {});
  },
  error(message, context) {
    console.error(message, context ?? {});
  },
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Thrown when a transaction was successfully sent (we have its hash) but
// confirmation couldn't be observed before rpcTimeoutMs elapsed. Carries the
// hash so a retry can check whether it actually landed before ever
// submitting a second, duplicate accrue() call, distinct from a failure
// before sendTransaction, where nothing was submitted and a fresh attempt
// is always safe.
class SubmissionInFlightError extends Error {
  constructor(
    readonly sentHash: string,
    cause: unknown
  ) {
    super(errorMessage(cause));
    this.name = "SubmissionInFlightError";
  }
}

// waitForTransaction (tx.ts) throws two meaningfully different errors:
// "Transaction X failed on-chain" (the network confirmed it, a permanent,
// known outcome) vs. "Timed out waiting for transaction X to confirm"
// (the client gave up, the real outcome is still unknown). Only the second
// is worth treating as transient/retryable-by-rechecking; the first means
// resubmitting would just fail the same way again (or waste a fee finding
// out), and should be reported as a definitive submit failure instead.
function isDefinitiveOnChainFailure(err: unknown): boolean {
  return rawErrorText(err).includes("failed on-chain");
}

// Thrown when a prior attempt's transaction was confirmed as genuinely
// failed on-chain (not merely unconfirmed/timed out). Always non-transient:
// retrying would resubmit a fresh transaction that has no reason to succeed
// where the first one didn't.
class SubmissionFailedError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "SubmissionFailedError";
  }
}

class KeeperRetryError extends Error {
  readonly attempts: number;
  readonly transient: boolean;

  constructor(err: unknown, attempts: number, transient: boolean) {
    super(errorMessage(err));
    this.name = "KeeperRetryError";
    this.attempts = attempts;
    this.transient = transient;
  }
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

function errorMessage(err: unknown): string {
  if (err instanceof Error)
    return err.message.split("\n")[0]?.trim() || err.message;
  return String(err);
}

// Unlike errorMessage() above (first line only, for concise logging/display),
// this keeps the full message for transient-error classification: a status
// code or keyword on a later line (e.g. a wrapped fetch error whose first
// line is generic) would otherwise be invisible to isTransientKeeperError.
function rawErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// simulateView returns unknown (a decoded ScVal), which can be null or a
// non-string value depending on how the contract's return type decodes.
// get_adapter()/get_protocol() are both documented to return a Symbol/
// Address that decodes to a string; anything else means the on-chain
// return type didn't match, and using it as a contract ID would otherwise
// surface as a confusing low-level `Contract` constructor error instead of
// this clear one.
function expectString(
  value: unknown,
  method: string,
  contractId: string
): string {
  if (typeof value !== "string") {
    throw new Error(
      `${method}() on ${contractId} did not return a string (got ${typeof value})`
    );
  }
  return value;
}

function describeSendError(res: rpc.Api.SendTransactionResponse): string {
  try {
    return res.errorResult?.result().switch().name ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

// HTTP status codes are matched with word boundaries so a permanent error
// whose message happens to contain those digits elsewhere (e.g. an amount or
// ledger number) isn't misclassified as transient.
const TRANSIENT_STATUS_CODE = /\b(429|500|502|503|504)\b/;

function isTransientKeeperError(err: unknown): boolean {
  // Explicit, not incidental: a confirmed on-chain failure must never be
  // treated as transient, regardless of what its message text happens to
  // contain.
  if (err instanceof SubmissionFailedError) return false;
  if (err instanceof SubmissionInFlightError) return true;
  const message = rawErrorText(err).toLowerCase();
  return (
    message.includes("try again") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("temporarily") ||
    TRANSIENT_STATUS_CODE.test(message)
  );
}

async function withKeeperRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig,
  logger: KeeperLogger,
  context: Record<string, unknown>,
  sleepFn: (ms: number) => Promise<void>
): Promise<{ value: T; attempts: number }> {
  let lastErr: unknown;
  let attempts = 0;
  let transient = false;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    attempts = attempt;
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      lastErr = err;
      transient = isTransientKeeperError(err);
      if (!transient || attempt >= config.maxAttempts) break;
      const delayMs = config.baseDelayMs * 2 ** (attempt - 1);
      if (
        config.deadlineAt !== undefined &&
        Date.now() + delayMs >= config.deadlineAt
      ) {
        logger.warn(
          "[accrual-keeper] stopping retries; run deadline approaching",
          { ...context, attempt, delayMs }
        );
        break;
      }
      logger.warn("[accrual-keeper] transient failure; retrying", {
        ...context,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error: errorMessage(err),
      });
      await sleepFn(delayMs);
    }
  }
  throw new KeeperRetryError(lastErr, attempts, transient);
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
      return withKeeperRetry(
        async () => {
          const adapterId = expectString(
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
        sleepFn
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
    const attempts = err instanceof KeeperRetryError ? err.attempts : 1;
    const transient =
      err instanceof KeeperRetryError
        ? err.transient
        : isTransientKeeperError(err);
    failures.push({
      vaultId: meta.id,
      vaultContractId,
      stage: "discover",
      attempts,
      transient,
      error: errorMessage(err),
    });
  }

  return { adapters, failures };
}

async function submitAccrualTransaction(
  adapter: DiscoveredAdapter,
  config: BlendAccrualKeeperConfig,
  server: KeeperRpcServer,
  priorHash?: string
): Promise<Omit<AccrualSuccess, "attempts" | "vaultId" | "adapterId">> {
  // An earlier attempt already sent a transaction. Check whether it
  // actually landed before ever submitting a second, duplicate accrue()
  // call. Once a transaction is in flight for this adapter, this function
  // never falls through to building a new one, only this branch, on every
  // subsequent attempt, until the prior transaction's fate is actually
  // known (confirmed success or confirmed failure). A second timeout here
  // re-throws to keep tracking the *same* hash on the next retry, rather
  // than abandoning it and creating a second real transaction, which would
  // reintroduce the exact double-submission this function exists to
  // prevent.
  if (priorHash) {
    try {
      const confirmed = await waitForTransaction(server, priorHash, {
        timeoutMs: CONFIRMATION_TIMEOUT_MS,
      });
      return { hash: priorHash, ledger: confirmed.ledger };
    } catch (err) {
      if (isDefinitiveOnChainFailure(err)) {
        throw new SubmissionFailedError(err);
      }
      throw new SubmissionInFlightError(priorHash, err);
    }
  }

  const keypair = Keypair.fromSecret(config.secretKey);
  const source = await withRaceTimeout(
    () => server.getAccount(keypair.publicKey()),
    config.rpcTimeoutMs,
    "Soroban RPC"
  );
  const contract = new Contract(adapter.adapterId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: config.network.passphrase,
  })
    .addOperation(contract.call("accrue"))
    .setTimeout(300)
    .build();

  const sim = await withRaceTimeout(
    () => server.simulateTransaction(tx),
    config.rpcTimeoutMs,
    "Soroban RPC"
  );
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${simErrorMessage(sim.error)}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("Simulation did not return a successful result");
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);

  const sent = await withRaceTimeout(
    () => server.sendTransaction(prepared),
    config.rpcTimeoutMs,
    "Soroban RPC"
  );
  if (sent.status === "ERROR") {
    throw new Error(
      `Transaction rejected at submission: ${describeSendError(sent)}`
    );
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new Error("Transaction could not be submitted yet (try again later)");
  }

  try {
    const confirmed = await waitForTransaction(server, sent.hash, {
      timeoutMs: CONFIRMATION_TIMEOUT_MS,
    });
    return { hash: sent.hash, ledger: confirmed.ledger };
  } catch (err) {
    // The network already confirmed this transaction failed, a permanent
    // outcome. Report it directly rather than treating it as retryable.
    if (isDefinitiveOnChainFailure(err)) {
      throw new SubmissionFailedError(err);
    }
    // Otherwise confirmation just wasn't observed in time; carry the hash
    // so a retry checks its real status first instead of blindly
    // submitting a duplicate accrue() call.
    throw new SubmissionInFlightError(sent.hash, err);
  }
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
    skipped.push({ ...adapter, reason: "non-blend" });
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
        { ...config, deadlineAt },
        logger,
        {
          vaultId: adapter.vaultId,
          adapterId: adapter.adapterId,
          protocol: adapter.protocol,
        },
        sleepFn
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
      const attempts = err instanceof KeeperRetryError ? err.attempts : 1;
      const transient =
        err instanceof KeeperRetryError
          ? err.transient
          : isTransientKeeperError(err);
      const failure: KeeperFailure = {
        vaultId: adapter.vaultId,
        vaultContractId: adapter.vaultContractId,
        adapterId: adapter.adapterId,
        protocol: adapter.protocol,
        stage: "submit",
        attempts,
        transient,
        error: errorMessage(err),
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
