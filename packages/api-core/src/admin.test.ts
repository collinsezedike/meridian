import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    fetchCoordinatorState: vi.fn(async () => ({
      protocol: "blend",
      adapterId: "ADAPTER_ID",
      totalShares: 1000,
      totalAssets: 1050,
      paused: false,
    })),
    getKeeperHeartbeat: vi.fn(async () => null),
    loadKeeperHeartbeatStore: vi.fn(() => ({})),
  };
});

import { handleGetKeeperHealth, handleGetVaultState } from "./admin";
import {
  fetchCoordinatorState,
  getKeeperHeartbeat,
  KNOWN_POOLS,
} from "@meridian/stellar-sdk-helpers";

beforeEach(() => vi.clearAllMocks());

describe("handleGetKeeperHealth", () => {
  it("reports both keepers as unhealthy when no heartbeat has ever been recorded", async () => {
    vi.mocked(getKeeperHeartbeat).mockResolvedValue(null);
    const result = await handleGetKeeperHealth();
    expect(result.status).toBe(200);
    const body = result.body as { keepers: Array<Record<string, unknown>> };
    expect(body.keepers).toHaveLength(2);
    for (const keeper of body.keepers) {
      expect(keeper.lastSuccessMs).toBeNull();
      expect(keeper.healthy).toBe(false);
    }
  });

  it("reports a keeper healthy when its last success is within schedule", async () => {
    vi.mocked(getKeeperHeartbeat).mockImplementation(async (_store, id) =>
      id === "accrual" ? Date.now() - 60_000 : null
    );
    const result = await handleGetKeeperHealth();
    const body = result.body as { keepers: Array<Record<string, unknown>> };
    const accrual = body.keepers.find((k) => k.id === "accrual");
    expect(accrual?.healthy).toBe(true);
  });

  it("reports a keeper unhealthy when its last success is far overdue", async () => {
    vi.mocked(getKeeperHeartbeat).mockImplementation(async (_store, id) =>
      id === "migration" ? Date.now() - 24 * 60 * 60_000 : null
    );
    const result = await handleGetKeeperHealth();
    const body = result.body as { keepers: Array<Record<string, unknown>> };
    const migration = body.keepers.find((k) => k.id === "migration");
    expect(migration?.healthy).toBe(false);
  });

  it("returns 500 when reading heartbeats throws unexpectedly", async () => {
    const err = new Error("boom");
    vi.mocked(getKeeperHeartbeat).mockRejectedValue(err);
    const result = await handleGetKeeperHealth();
    // getKeeperHeartbeat itself never throws in real usage (see
    // keeper-heartbeat.ts), but the handler still needs to degrade
    // gracefully if a future change to it, or to Promise.all's shape here,
    // ever lets a rejection through.
    expect(result.status).toBe(500);
    expect(result.error).toBe(err);
  });
});

describe("handleGetVaultState", () => {
  it("returns the coordinator vault's state for the configured network", async () => {
    const result = await handleGetVaultState();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      protocol: "blend",
      adapterId: "ADAPTER_ID",
      totalShares: 1000,
      totalAssets: 1050,
      paused: false,
    });
  });

  it("returns 503 when the on-chain read fails", async () => {
    const err = new Error("rpc unavailable");
    vi.mocked(fetchCoordinatorState).mockRejectedValueOnce(err);
    const result = await handleGetVaultState();
    expect(result.status).toBe(503);
    expect(result.error).toBe(err);
  });

  it("returns 404 when no Meridian coordinator vault is configured for this network", async () => {
    // No mocking hook exists for "no configured vault" today, so simulate it
    // directly: temporarily strip the one field handleGetVaultState's find()
    // requires (a "meridian" protocol entry with a contractId) and restore
    // it after, so this test doesn't leak state into any other test.
    const entry = Object.values(KNOWN_POOLS.testnet).find(
      (p) => p.protocol === "meridian"
    );
    if (!entry) throw new Error("expected a testnet meridian pool to exist");
    const originalContractId = entry.contractId;
    // @ts-expect-error -- deliberately violating TestnetPoolMeta's required
    // contractId to simulate the not-yet-deployed case handleGetVaultState guards against.
    delete entry.contractId;

    try {
      const result = await handleGetVaultState();
      expect(result.status).toBe(404);
      expect(result.body).toEqual({
        error: "No Meridian coordinator vault configured for this network",
      });
    } finally {
      entry.contractId = originalContractId;
    }
  });
});
