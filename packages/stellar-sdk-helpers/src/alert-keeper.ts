// Admin-event alerting keeper (#707).
//
// #698 added on-chain events for admin actions (paused, transfer, adapter,
// migrate, accept) and getRpcAdminHistory (admin-history.ts, #697) already
// knows how to read them back from Soroban RPC. Nothing consumed that feed
// for alerting until now: an unexpected pause or an adapter migration was
// only noticed by whoever happened to check the app.
//
// This keeper polls getRpcAdminHistory per known Meridian vault, starting
// from a persisted "last-processed ledger" cursor so a restart never
// replays events it already alerted on, and posts one webhook message per
// qualifying action. It deliberately reuses keeper-heartbeat.ts's
// KeeperHeartbeatStore for that cursor: the store is already a generic
// last-write-wins numeric KV (see its own header comment), and a ledger
// cursor has exactly the same consistency requirements as a heartbeat
// timestamp — the last run to finish is definitionally the most recent
// state, so no lease/CAS semantics are needed here either.
//
// `accept_admin` is intentionally excluded from alerting even though it is
// a recognised RpcAdminActionType: it is the second half of an
// already-alerted `transfer_admin` nomination, not a new risk on its own
// (see #707's acceptance criteria, which lists paused/transfer/adapter/
// migrate only).

import { rpc } from "@stellar/stellar-sdk";
import { withRaceTimeout, withRetry } from "@meridian/shared";
import { APP_NETWORK } from "@meridian/shared";
import {
  getRpcAdminHistory,
  type RpcAdminAction,
  type RpcAdminActionType,
} from "./admin-history";
import { KNOWN_POOLS } from "./known-pools";
import type { StellarNetwork } from "./types";
import {
  consoleLogger,
  errorMessage,
  parsePositiveInt,
  type KeeperLogger,
} from "./keeper-retry";
import {
  createInMemoryKeeperHeartbeatStore,
  type KeeperHeartbeatStore,
} from "./keeper-heartbeat";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** Admin actions worth an immediate alert. See the file header for why
 *  `accept` is deliberately left out. */
const ALERTABLE_ACTIONS: ReadonlySet<RpcAdminActionType> = new Set([
  "paused",
  "transfer",
  "adapter",
  "migrate",
]);

export interface AlertKeeperConfig {
  network: StellarNetwork;
  webhookUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  rpcTimeoutMs: number;
}

export function loadAlertKeeperConfig(
  env: Record<string, string | undefined>
): AlertKeeperConfig {
  const webhookUrl = env.MERIDIAN_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error("MERIDIAN_ALERT_WEBHOOK_URL is required");
  }

  return {
    network: APP_NETWORK,
    webhookUrl,
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

export interface AlertVaultTarget {
  vaultId: string;
  vaultContractId: string;
}

/** Every known Meridian vault on `network`, the same protocol/contractId
 *  filter accrual-keeper.ts's discovery uses. */
export function discoverAlertVaultTargets(
  network: StellarNetwork
): AlertVaultTarget[] {
  const networkKey = network.network === "mainnet" ? "mainnet" : "testnet";
  const pools = KNOWN_POOLS[networkKey];
  return Object.entries(pools)
    .filter(([, meta]) => meta.protocol === "meridian" && meta.contractId)
    .map(([vaultId, meta]) => ({
      vaultId,
      vaultContractId: meta.contractId as string,
    }));
}

/** Namespaced by network and vault so one vault's cursor can never bleed
 *  into another's, mirroring keeper-state.ts's submissionStateKey. */
export function alertCursorKey(
  vaultContractId: string,
  network: string
): string {
  return [
    "meridian",
    "keeper",
    "alert",
    "cursor",
    network,
    vaultContractId,
  ].join(":");
}

function shortAddr(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

/** Human-readable alert text for one on-chain admin action. Exported for
 *  tests; not expected to be called on an "accept" action since
 *  ALERTABLE_ACTIONS filters it out first, but handled for exhaustiveness. */
export function formatAlertMessage(
  vaultId: string,
  action: RpcAdminAction
): string {
  const at = `ledger ${action.ledgerSequence}`;
  // RpcAdminActionPayload is not discriminated by `action.action` at the
  // type level (see admin-history.ts), so each arm asserts its own shape;
  // parseAdminEvent there is what actually guarantees the pairing at
  // runtime.
  switch (action.action) {
    case "paused": {
      const { paused } = action.payload as { paused: boolean };
      return paused
        ? `[meridian] ${vaultId}: deposits PAUSED at ${at}`
        : `[meridian] ${vaultId}: deposits unpaused at ${at}`;
    }
    case "transfer": {
      const { newAdmin } = action.payload as { newAdmin: string };
      return `[meridian] ${vaultId}: admin transfer nominated to ${shortAddr(newAdmin)} at ${at}`;
    }
    case "accept": {
      const { newAdmin } = action.payload as { newAdmin: string };
      return `[meridian] ${vaultId}: admin transfer to ${shortAddr(newAdmin)} accepted at ${at}`;
    }
    case "adapter": {
      const { newAdapter } = action.payload as { newAdapter: string };
      return `[meridian] ${vaultId}: adapter switched to ${shortAddr(newAdapter)} at ${at}`;
    }
    case "migrate": {
      const { oldAdapter, newAdapter } = action.payload as {
        oldAdapter: string;
        newAdapter: string;
      };
      return `[meridian] ${vaultId}: migrated adapter from ${shortAddr(oldAdapter)} to ${shortAddr(newAdapter)} at ${at}`;
    }
  }
}

/**
 * Posts one alert to `webhookUrl`. Both `text` (Slack's field) and
 * `content` (Discord's field) are sent in the same JSON body so one webhook
 * configuration works against either service without the operator having
 * to pick a payload shape up front; each service ignores the field it
 * doesn't recognise.
 */
async function sendAlert(
  webhookUrl: string,
  message: string,
  options: {
    maxAttempts: number;
    baseDelayMs: number;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  }
): Promise<void> {
  await withRetry(
    async () => {
      const response = await withRaceTimeout(
        () =>
          options.fetchImpl(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: message, content: message }),
            signal: AbortSignal.timeout(options.timeoutMs),
          }),
        options.timeoutMs,
        "alert webhook"
      );
      if (!response.ok) {
        throw new Error(
          `alert webhook request failed with HTTP ${response.status}`
        );
      }
    },
    options.maxAttempts,
    options.baseDelayMs
  );
}

export interface AlertSuccess {
  vaultId: string;
  action: RpcAdminActionType;
  ledgerSequence: number;
}

export interface AlertFailure {
  vaultId: string;
  vaultContractId: string;
  stage: "discover" | "send";
  attempts: number;
  error: string;
}

export interface AlertKeeperResult {
  network: StellarNetwork["network"];
  startedAt: string;
  finishedAt: string;
  vaultsChecked: number;
  alertsSent: AlertSuccess[];
  failures: AlertFailure[];
}

export interface AlertKeeperDeps {
  /** Defaults to whatever the environment provides (Upstash when
   *  configured); an in-memory store when omitted entirely, same fallback
   *  shape as the other keepers use for their own stores. */
  cursorStore?: KeeperHeartbeatStore;
  logger?: KeeperLogger;
  fetchImpl?: typeof fetch;
  /** Overrides vault discovery; used by tests. */
  targets?: AlertVaultTarget[];
}

/**
 * Runs one alerting pass over every known Meridian vault: reads each
 * vault's admin-event history since its last-processed ledger, posts a
 * webhook alert for every qualifying action, and advances the cursor only
 * as far as the last action it successfully alerted on (or that needed no
 * alert at all). A failed send stops that vault's cursor from advancing
 * past it, so the failed action (and anything after it in the same page)
 * is retried on the next scheduled run instead of being silently skipped.
 */
/** One vault's worth of work for a single run: resolve its start ledger,
 *  fetch admin history since it, alert on every qualifying action, and
 *  persist however far the cursor actually got. Extracted so `runAlertKeeper`
 *  can run every vault concurrently, the same reasoning
 *  `accrual-keeper.ts`'s discovery uses for its own per-vault work: each
 *  vault's RPC fetch and webhook sends are independent of every other
 *  vault's, so running them one at a time would let the endpoint's 60s
 *  `maxDuration` (see vercel.json) get eaten by earlier vaults before later
 *  ones are even attempted. */
async function processVaultAlerts(
  target: AlertVaultTarget,
  config: AlertKeeperConfig,
  cursorStore: KeeperHeartbeatStore,
  fetchImpl: typeof fetch,
  logger: KeeperLogger
): Promise<{ alertsSent: AlertSuccess[]; failures: AlertFailure[] }> {
  const key = alertCursorKey(target.vaultContractId, config.network.network);
  const alertsSent: AlertSuccess[] = [];
  const failures: AlertFailure[] = [];

  let startLedger: number;
  try {
    const stored = await cursorStore.get(key);
    if (stored !== null) {
      startLedger = stored;
    } else {
      // No cursor yet: start from the current ledger rather than replaying
      // this vault's entire history as alerts on first deploy. Restart
      // safety only needs to cover events since the keeper started
      // watching, not events that predate it.
      const server = new rpc.Server(config.network.rpcUrl);
      const latest = await withRaceTimeout(
        () => server.getLatestLedger(),
        config.rpcTimeoutMs,
        "Soroban RPC"
      );
      startLedger = latest.sequence;
    }
  } catch (err) {
    failures.push({
      vaultId: target.vaultId,
      vaultContractId: target.vaultContractId,
      stage: "discover",
      attempts: 1,
      error: errorMessage(err),
    });
    return { alertsSent, failures };
  }

  let actions: RpcAdminAction[];
  try {
    const result = await withRetry(
      () =>
        withRaceTimeout(
          () =>
            getRpcAdminHistory(config.network.rpcUrl, target.vaultContractId, {
              startLedger,
            }),
          config.rpcTimeoutMs,
          "Soroban RPC"
        ),
      config.maxAttempts,
      config.baseDelayMs
    );
    actions = result.actions;
  } catch (err) {
    failures.push({
      vaultId: target.vaultId,
      vaultContractId: target.vaultContractId,
      stage: "discover",
      attempts: config.maxAttempts,
      error: errorMessage(err),
    });
    return { alertsSent, failures };
  }

  let cursor = startLedger;
  for (const action of actions) {
    if (ALERTABLE_ACTIONS.has(action.action)) {
      try {
        await sendAlert(
          config.webhookUrl,
          formatAlertMessage(target.vaultId, action),
          {
            maxAttempts: config.maxAttempts,
            baseDelayMs: config.baseDelayMs,
            timeoutMs: config.rpcTimeoutMs,
            fetchImpl,
          }
        );
        alertsSent.push({
          vaultId: target.vaultId,
          action: action.action,
          ledgerSequence: action.ledgerSequence,
        });
      } catch (err) {
        failures.push({
          vaultId: target.vaultId,
          vaultContractId: target.vaultContractId,
          stage: "send",
          attempts: config.maxAttempts,
          error: errorMessage(err),
        });
        break;
      }
    }
    cursor = action.ledgerSequence + 1;
  }

  try {
    await cursorStore.set(key, cursor);
  } catch (err) {
    logger.warn("[alert-keeper] could not persist cursor", {
      vaultId: target.vaultId,
      error: errorMessage(err),
    });
  }

  return { alertsSent, failures };
}

export async function runAlertKeeper(
  config: AlertKeeperConfig,
  deps: AlertKeeperDeps = {}
): Promise<AlertKeeperResult> {
  const startedAt = new Date().toISOString();
  const logger = deps.logger ?? consoleLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cursorStore = deps.cursorStore ?? createInMemoryKeeperHeartbeatStore();
  const targets = deps.targets ?? discoverAlertVaultTargets(config.network);

  const settled = await Promise.all(
    targets.map((target) =>
      processVaultAlerts(target, config, cursorStore, fetchImpl, logger)
    )
  );

  const alertsSent = settled.flatMap((r) => r.alertsSent);
  const failures = settled.flatMap((r) => r.failures);

  return {
    network: config.network.network,
    startedAt,
    finishedAt: new Date().toISOString(),
    vaultsChecked: targets.length,
    alertsSent,
    failures,
  };
}
