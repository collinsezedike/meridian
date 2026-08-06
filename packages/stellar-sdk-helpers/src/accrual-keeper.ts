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
const DEFAULT_RPC_TIMEOUT_MS = 12_000;

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

function describeSendError(res: rpc.Api.SendTransactionResponse): string {
  try {
    return res.errorResult?.result().switch().name ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function isTransientKeeperError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes("try again") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("temporarily") ||
    message.includes("not_found")
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
  };
  const adapters: DiscoveredAdapter[] = [];
  const failures: KeeperFailure[] = [];

  for (const meta of Object.values(pools)) {
    if (meta.protocol !== "meridian" || !meta.contractId) continue;
    const vaultContractId = meta.contractId;

    try {
      const result = await withKeeperRetry(
        async () => {
          const adapterId = (await simulate(
            server as never,
            vaultContractId,
            network.passphrase,
            "get_adapter"
          )) as string;
          const protocol = (await simulate(
            server as never,
            adapterId,
            network.passphrase,
            "get_protocol"
          )) as string;
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
      adapters.push(result.value);
    } catch (err) {
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
  }

  return { adapters, failures };
}

async function submitAccrualTransaction(
  adapter: DiscoveredAdapter,
  config: BlendAccrualKeeperConfig,
  server: KeeperRpcServer
): Promise<Omit<AccrualSuccess, "attempts" | "vaultId" | "adapterId">> {
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

  const confirmed = await waitForTransaction(server, sent.hash);
  return { hash: sent.hash, ledger: confirmed.ledger };
}

export async function runBlendAccrualKeeper(
  config: BlendAccrualKeeperConfig,
  deps: BlendAccrualKeeperDeps = {}
): Promise<BlendAccrualKeeperResult> {
  const logger = deps.logger ?? consoleLogger;
  const sleepFn = deps.sleep ?? sleep;
  const startedAt = new Date().toISOString();
  const server = getRpcServer(config.network.rpcUrl, config.rpcTimeoutMs);
  const discovery = deps.discoverAdapters
    ? await deps.discoverAdapters()
    : await discoverLiveAdapters({
        network: config.network,
        server,
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.baseDelayMs,
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

  for (const adapter of blendAdapters) {
    try {
      const result = await withKeeperRetry(
        (attempt) =>
          deps.submitAccrual
            ? deps.submitAccrual(adapter, attempt)
            : submitAccrualTransaction(adapter, config, server),
        config,
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
