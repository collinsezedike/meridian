import { rpc, xdr } from "@stellar/stellar-sdk";
import { errorMessage, type KeeperLogger } from "./keeper-retry";
import { withRaceTimeout } from "@meridian/shared";
import type { StellarNetwork } from "./types";

/* ───────────────────────────────────────────────────────────────────────────
 * Contract event monitoring and alerting service (#707)
 *
 * Polls Soroban RPC `getEvents` for vault admin-action events and forwards
 * alerts to a configured webhook (Slack / Discord / generic HTTP).
 *
 * Tracks its own last-processed ledger so a restart does not replay old
 * events — the same heartbeat pattern used by the accrual/migration keepers.
 * ──────────────────────────────────────────────────────────────────────── */

export type AlertableEventType = "paused" | "transfer" | "accept" | "adapter" | "migrate";

export const ALERTABLE_EVENTS: AlertableEventType[] = [
  "paused",
  "transfer",
  "accept",
  "adapter",
  "migrate",
];

export interface EventMonitorConfig {
  rpcUrl: string;
  vaultContractId: string;
  networkPassphrase: string;
  /** Webhook URL for outgoing alerts. */
  webhookUrl: string;
  /** Poll interval in milliseconds. Default: 60_000 (1 minute). */
  pollIntervalMs?: number;
  /** RPC request timeout. Default: 10_000 ms. */
  rpcTimeoutMs?: number;
  /** Webhook POST timeout. Default: 5_000 ms. */
  webhookTimeoutMs?: number;
  /** Optional auth header sent with every webhook POST. */
  webhookAuthHeader?: string;
}

export interface EventMonitorStore {
  /** Returns the last processed ledger sequence, or null if never run. */
  getLastLedger(): Promise<number | null>;
  /** Records the ledger sequence as the latest processed. */
  setLastLedger(ledger: number): Promise<void>;
}

export interface AlertPayload {
  event: AlertableEventType;
  vaultContractId: string;
  ledgerSequence: number;
  timestamp?: string;
  details: Record<string, unknown>;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

const ADMIN_TOPIC_XDR: string = xdr.ScVal.scvSymbol("admin").toXDR("base64");

function buildEventFilter(vaultContractId: string): rpc.Api.EventFilter {
  return {
    type: "contract",
    contractIds: [vaultContractId],
    topics: [[ADMIN_TOPIC_XDR, "*"]],
  };
}

function parseAlertableEvent(
  event: rpc.Api.EventResponse
): AlertPayload | null {
  const topic = event.topic;
  if (!topic || topic.length < 2) return null;

  const actionVal = topic[1];
  if (actionVal.switch().name !== "scvSymbol") return null;
  const action = actionVal.sym().toString() as AlertableEventType;
  if (!ALERTABLE_EVENTS.includes(action)) return null;

  const value = event.value;
  let details: Record<string, unknown> = {};

  switch (action) {
    case "paused": {
      if (value.switch().name === "scvBool") {
        details = { paused: value.b() };
      }
      break;
    }
    case "transfer":
    case "accept": {
      details = { newAdmin: parseAddress(value) };
      break;
    }
    case "adapter": {
      details = { newAdapter: parseAddress(value) };
      break;
    }
    case "migrate": {
      if (value.switch().name === "scvVec") {
        const items = value.vec();
        if (items && items.length >= 2) {
          details = {
            oldAdapter: parseAddress(items[0]!),
            newAdapter: parseAddress(items[1]!),
          };
        }
      }
      break;
    }
  }

  return {
    event: action,
    vaultContractId: event.contractId?.string() ?? "",
    ledgerSequence: event.ledger,
    ...(event.ledgerClosedAt ? { timestamp: event.ledgerClosedAt } : {}),
    details,
  };
}

function parseAddress(val: xdr.ScVal): string | null {
  if (val.switch().name !== "scvAddress") return null;
  try {
    // Use dynamic import to avoid circular dependency issues
    const { Address } = require("@stellar/stellar-sdk");
    return Address.fromScVal(val).toString();
  } catch {
    return null;
  }
}

/**
 * Polls RPC `getEvents` once, filters to alertable admin actions, and sends
 * a webhook POST for each new event since the last stored ledger.
 *
 * Returns the highest ledger sequence processed, or null if no events were
 * found.
 */
export async function pollAndAlert(
  config: EventMonitorConfig,
  store: EventMonitorStore,
  logger: KeeperLogger
): Promise<number | null> {
  const server = new rpc.Server(config.rpcUrl);
  const lastLedger = await store.getLastLedger();
  const startLedger = lastLedger ? lastLedger + 1 : 0;

  const filters = [buildEventFilter(config.vaultContractId)];

  let response: rpc.Api.GetEventsResponse;
  try {
    response = await withRaceTimeout(
      server.getEvents({
        filters,
        startLedger,
        limit: 200,
      }),
      config.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    );
  } catch (err) {
    logger.error("[event-monitor] RPC getEvents failed", {
      error: errorMessage(err),
      startLedger,
    });
    return null;
  }

  const events = response.events ?? [];
  if (events.length === 0) {
    logger.info("[event-monitor] no new events", { startLedger });
    return lastLedger;
  }

  let maxLedger = lastLedger ?? 0;
  const webhookUrl = config.webhookUrl;
  const webhookTimeout = config.webhookTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.webhookAuthHeader) {
    headers["Authorization"] = config.webhookAuthHeader;
  }

  for (const raw of events) {
    const parsed = parseAlertableEvent(raw);
    if (!parsed) continue;

    maxLedger = Math.max(maxLedger, raw.ledger);

    try {
      await withRaceTimeout(
        fetch(webhookUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(parsed),
        }).then(async (res) => {
          if (!res.ok) {
            throw new Error(`webhook returned ${res.status}`);
          }
        }),
        webhookTimeout
      );
      logger.info("[event-monitor] alert sent", {
        event: parsed.event,
        ledger: parsed.ledgerSequence,
      });
    } catch (err) {
      logger.error("[event-monitor] webhook delivery failed", {
        event: parsed.event,
        ledger: parsed.ledgerSequence,
        error: errorMessage(err),
      });
    }
  }

  await store.setLastLedger(maxLedger);
  return maxLedger;
}

/**
 * Runs the event monitor loop until `signal` is aborted.
 *
 * Waits `pollIntervalMs` between polls, skipping immediately when the
 * previous poll is still in flight (simple back-pressure).
 */
export async function runEventMonitor(
  config: EventMonitorConfig,
  store: EventMonitorStore,
  logger: KeeperLogger,
  signal: AbortSignal
): Promise<void> {
  const interval = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let inFlight = false;

  while (!signal.aborted) {
    if (inFlight) {
      logger.warn("[event-monitor] previous poll still in flight, skipping");
    } else {
      inFlight = true;
      try {
        await pollAndAlert(config, store, logger);
      } catch (err) {
        logger.error("[event-monitor] unexpected error", {
          error: errorMessage(err),
        });
      } finally {
        inFlight = false;
      }
    }

    await sleep(interval, signal);
  }

  logger.info("[event-monitor] shut down");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
