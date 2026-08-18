import {
  Account,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { APP_NETWORK, withRaceTimeout, withRetry } from "@meridian/shared";
import { KNOWN_POOLS, type KnownPoolMeta } from "./known-pools";
import { BASE_FEE, getRpcServer } from "./internal";
import {
  assertSubmittable,
  assertSubmittableContractId,
  simulateView,
  simErrorMessage,
  submitPreparedTransaction,
} from "./tx";
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
  allowedAdapterIds: string[];
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

function parseContractIdList(value: string | undefined, name: string): string[] {
  if (!value?.trim()) return [];
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!/^C[A-Z2-7]{55}$/.test(id)) {
      throw new Error(`${name} must contain Stellar contract IDs`);
    }
  }
  return [...new Set(ids)];
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
    allowedAdapterIds: parseContractIdList(
      env.MERIDIAN_KEEPER_ALLOWED_ADAPTER_IDS,
      "MERIDIAN_KEEPER_ALLOWED_ADAPTER_IDS"
    ),
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error)
    return err.message.split("\n")[0]?.trim() || err.message;
  return String(err);
}

export function isTransientKeeperError(err: unknown): boolean {
  const status = numericField(err, [
    "status",
    "statusCode",
    "code",
    "response.status",
  ]);
  if (status && [408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = stringField(err, ["code", "name", "response.data.code"]);
  if (
    code &&
    [
      "aborterror",
      "eai_again",
      "econnaborted",
      "econnrefused",
      "econnreset",
      "enetunreach",
      "etimedout",
      "not_found",
      "timeout",
      "timeouterror",
      "und_err_connect_timeout",
    ].includes(code.toLowerCase())
  ) {
    return true;
  }

  const message = errorMessage(err).trim().toLowerCase();
  return (
    /\btry again(?: later)?\b/.test(message) ||
    /\b(?:timeout|timed out)\b/.test(message) ||
    /\brate limit(?:ed)?\b/.test(message) ||
    /\btemporarily unavailable\b/.test(message) ||
    /^(?:http|rpc|server|stellar|soroban)?\s*(?:error|status|response)?\s*(?:code)?\s*[:=-]?\s*(?:408|409|425|429|500|502|503|504)\b/.test(
      message
    ) ||
    /^not_found$/.test(message)
  );
}

function numericField(err: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = nestedField(err, path);
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function stringField(err: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = nestedField(err, path);
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function nestedField(err: unknown, path: string): unknown {
  let value: unknown = err;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

async function withKeeperRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig,
  logger: KeeperLogger,
  context: Record<string, unknown>,
  sleepFn: (ms: number) => Promise<void>
): Promise<{ value: T; attempts: number }> {
  let attempts = 0;
  let transient = false;
  try {
    const value = await withRetry(
      async (attempt) => {
        attempts = attempt;
        return fn(attempt);
      },
      config.maxAttempts,
      config.baseDelayMs,
      (err) => {
        transient = isTransientKeeperError(err);
        return transient;
      },
      {
        sleep: sleepFn,
        onRetry: ({ attempt, nextAttempt, delayMs, error }) => {
          logger.warn("[accrual-keeper] transient failure; retrying", {
            ...context,
            attempt,
            nextAttempt,
            delayMs,
            error: errorMessage(error),
          });
        },
      }
    );
    return { value, attempts };
  } catch (err) {
    throw new KeeperRetryError(
      err,
      attempts || 1,
      transient || isTransientKeeperError(err)
    );
  }
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
  const configuredMeridianPools = Object.values(pools).filter(
    (meta): meta is KnownPoolMeta & { contractId: string } =>
      meta.protocol === "meridian" && Boolean(meta.contractId)
  );

  if (networkKey === "mainnet" && configuredMeridianPools.length === 0) {
    failures.push({
      stage: "discover",
      attempts: 0,
      transient: false,
      error:
        "No mainnet Meridian vaults are configured for the accrual keeper",
    });
    return { adapters, failures };
  }

  for (const meta of configuredMeridianPools) {
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
  const submittableOptions = {
    additionalContractIds: config.allowedAdapterIds,
  };
  assertSubmittableContractId(
    adapter.adapterId,
    config.network,
    submittableOptions
  );
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
  assertSubmittable(prepared, config.network, submittableOptions);
  prepared.sign(keypair);

  const submitted = await submitPreparedTransaction(
    prepared,
    server,
    config.network,
    {
      ...submittableOptions,
      rpcTimeoutMs: config.rpcTimeoutMs,
      timeoutMs: config.rpcTimeoutMs,
    }
  );
  return { hash: submitted.hash, ledger: submitted.ledger };
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
