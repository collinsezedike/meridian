import { describe, expect, it, vi } from "vitest";

import {
  KEEPER_SCHEDULE_MS,
  createInMemoryKeeperHeartbeatStore,
  createUpstashKeeperHeartbeatStore,
  getKeeperHeartbeat,
  heartbeatKey,
  isKeeperHealthy,
  loadKeeperHeartbeatStore,
  recordKeeperHeartbeat,
  type KeeperHeartbeatStore,
} from "./keeper-heartbeat";
import type { KeeperLogger } from "./keeper-retry";

function logger(): KeeperLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("heartbeatKey", () => {
  it("namespaces by keeper and network", () => {
    expect(heartbeatKey("accrual", "testnet")).toBe(
      "meridian:keeper:heartbeat:accrual:testnet"
    );
    expect(heartbeatKey("migration", "mainnet")).toBe(
      "meridian:keeper:heartbeat:migration:mainnet"
    );
  });
});

describe("isKeeperHealthy", () => {
  it("is unhealthy when no success has ever been recorded", () => {
    expect(isKeeperHealthy("accrual", null)).toBe(false);
  });

  it("is healthy within the schedule interval", () => {
    const now = 1_000_000;
    expect(
      isKeeperHealthy("accrual", now - KEEPER_SCHEDULE_MS.accrual / 2, now)
    ).toBe(true);
  });

  it("stays healthy through one missed tick (2x grace) but not two", () => {
    const now = 10_000_000;
    const interval = KEEPER_SCHEDULE_MS.migration;
    expect(isKeeperHealthy("migration", now - interval * 1.9, now)).toBe(true);
    expect(isKeeperHealthy("migration", now - interval * 2.1, now)).toBe(false);
  });
});

describe("recordKeeperHeartbeat / getKeeperHeartbeat", () => {
  it("round-trips a recorded success time through an in-memory store", async () => {
    const store = createInMemoryKeeperHeartbeatStore();
    await recordKeeperHeartbeat(store, "accrual", "testnet", logger(), 123);
    expect(
      await getKeeperHeartbeat(store, "accrual", "testnet", logger())
    ).toBe(123);
  });

  it("keeps accrual and migration heartbeats independent", async () => {
    const store = createInMemoryKeeperHeartbeatStore();
    await recordKeeperHeartbeat(store, "accrual", "testnet", logger(), 1);
    await recordKeeperHeartbeat(store, "migration", "testnet", logger(), 2);
    expect(
      await getKeeperHeartbeat(store, "accrual", "testnet", logger())
    ).toBe(1);
    expect(
      await getKeeperHeartbeat(store, "migration", "testnet", logger())
    ).toBe(2);
  });

  it("returns null and does not throw when the store read fails", async () => {
    const failing: KeeperHeartbeatStore = {
      get: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
      set: vi.fn(),
    };
    const log = logger();
    const result = await getKeeperHeartbeat(failing, "accrual", "testnet", log);
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("does not throw when the store write fails", async () => {
    const failing: KeeperHeartbeatStore = {
      get: vi.fn(),
      set: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const log = logger();
    await expect(
      recordKeeperHeartbeat(failing, "accrual", "testnet", log, 1)
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("createUpstashKeeperHeartbeatStore", () => {
  function fetchMock(response: unknown) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => response,
    })) as unknown as typeof fetch;
  }

  it("reads a stored timestamp back as a number", async () => {
    const fetchImpl = fetchMock({ result: "12345" });
    const store = createUpstashKeeperHeartbeatStore({
      url: "https://redis.example/",
      token: "tok",
      fetchImpl,
    });
    expect(await store.get("k")).toBe(12345);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(["GET", "k"]),
      })
    );
  });

  it("returns null when nothing is stored", async () => {
    const store = createUpstashKeeperHeartbeatStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl: fetchMock({ result: null }),
    });
    expect(await store.get("k")).toBeNull();
  });

  it("writes with an unconditional SET, no NX and no expiry", async () => {
    const fetchImpl = fetchMock({ result: "OK" });
    const store = createUpstashKeeperHeartbeatStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl,
    });
    await store.set("k", 999);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({
        body: JSON.stringify(["SET", "k", "999"]),
      })
    );
  });
});

describe("loadKeeperHeartbeatStore", () => {
  it("falls back to an in-memory store when Upstash is not configured", async () => {
    const log = logger();
    const store = loadKeeperHeartbeatStore({}, { logger: log });
    await store.set("k", 1);
    expect(await store.get("k")).toBe(1);
    expect(log.info).toHaveBeenCalled();
  });

  it("warns (not just informs) when deployed without Upstash configured", () => {
    const log = logger();
    loadKeeperHeartbeatStore({ VERCEL_ENV: "production" }, { logger: log });
    expect(log.warn).toHaveBeenCalled();
  });

  it("picks the Upstash store when both env vars are present", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
    })) as unknown as typeof fetch;
    const store = loadKeeperHeartbeatStore(
      {
        UPSTASH_REDIS_REST_URL: "https://redis.example",
        UPSTASH_REDIS_REST_TOKEN: "tok",
      },
      { logger: logger(), fetchImpl }
    );
    await store.get("k");
    // The in-memory store never calls fetch at all, so a call here proves
    // the Upstash-backed store was picked instead.
    expect(fetchImpl).toHaveBeenCalled();
  });
});
