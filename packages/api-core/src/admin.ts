import { APP_NETWORK } from "@meridian/shared";
import {
  consoleLogger,
  fetchCoordinatorState,
  getKeeperHeartbeat,
  isKeeperHealthy,
  KEEPER_SCHEDULE_MS,
  KNOWN_POOLS,
  loadKeeperHeartbeatStore,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

export interface KeeperHealthEntry {
  id: "accrual" | "migration";
  intervalMs: number;
  lastSuccessMs: number | null;
  healthy: boolean;
}

/**
 * Reads both keepers' last-recorded success time (see keeper-heartbeat.ts)
 * and reports whether each is within its own schedule's overdue window.
 * Read-only and side-effect free: this never runs a keeper, only reports on
 * past runs recorded by api/v1/keepers/accrue.ts and rebalance.ts.
 */
export async function handleGetKeeperHealth(): Promise<RouteResult> {
  try {
    const store = loadKeeperHeartbeatStore(process.env, {
      logger: consoleLogger,
    });
    const now = Date.now();
    const keepers: KeeperHealthEntry[] = await Promise.all(
      (["accrual", "migration"] as const).map(async (id) => {
        const lastSuccessMs = await getKeeperHeartbeat(
          store,
          id,
          APP_NETWORK.network,
          consoleLogger
        );
        return {
          id,
          intervalMs: KEEPER_SCHEDULE_MS[id],
          lastSuccessMs,
          healthy: isKeeperHealthy(id, lastSuccessMs, now),
        };
      })
    );
    return {
      status: 200,
      body: { keepers, checkedAt: new Date(now).toISOString() },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: "Failed to read keeper health" },
      error: err,
    };
  }
}

/**
 * Reads the Meridian coordinator vault's current operational state for the
 * admin dashboard's Vault State card. There is exactly one coordinator vault
 * per network in KNOWN_POOLS today (see known-pools.ts); if that ever
 * changes, this picks the first one rather than guessing which is "the"
 * vault the dashboard should show.
 */
export async function handleGetVaultState(): Promise<RouteResult> {
  const pools =
    APP_NETWORK.network === "testnet"
      ? KNOWN_POOLS.testnet
      : KNOWN_POOLS.mainnet;
  const entry = Object.values(pools).find(
    (p): p is typeof p & { contractId: string } =>
      p.protocol === "meridian" && Boolean(p.contractId)
  );
  if (!entry) {
    return {
      status: 404,
      body: {
        error: "No Meridian coordinator vault configured for this network",
      },
    };
  }

  try {
    const state = await fetchCoordinatorState({
      contractId: entry.contractId,
      network: APP_NETWORK,
    });
    return { status: 200, body: state };
  } catch (err) {
    return {
      status: 503,
      body: { error: "Failed to read vault state" },
      error: err,
    };
  }
}
