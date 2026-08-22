import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SUBMISSION_TTL_MS,
  clearSubmission,
  createInMemoryKeeperStateStore,
  createUpstashKeeperStateStore,
  loadKeeperStateStore,
  parseSubmissionTtlMs,
  recordSubmission,
  resolvePriorSubmission,
  submissionStateKey,
  type KeeperStateStore,
  type SubmissionRecord,
} from "./keeper-state";
import type { KeeperLogger } from "./keeper-retry";

function logger(): KeeperLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function memoryStore(initial?: Record<string, SubmissionRecord>) {
  const store = createInMemoryKeeperStateStore();
  for (const [key, record] of Object.entries(initial ?? {})) {
    void store.set(key, record, DEFAULT_SUBMISSION_TTL_MS);
  }
  return store;
}

function lookup(response: unknown) {
  return {
    getTransaction: vi.fn(async () => response as never),
  };
}

const KEY = "meridian:keeper:migration:testnet:meridian-usdc";

describe("submissionStateKey", () => {
  it("namespaces by keeper and network so records can never be read across either", () => {
    // A testnet run blocking a mainnet one, or the accrue keeper reading the
    // migration keeper's record, would both be silent and confusing.
    expect(submissionStateKey("migration", "testnet", "meridian-usdc")).toBe(
      KEY
    );
    expect(
      submissionStateKey("accrual", "mainnet", "meridian-usdc", "CADAPTER")
    ).toBe("meridian:keeper:accrual:mainnet:meridian-usdc:CADAPTER");
  });
});

describe("parseSubmissionTtlMs", () => {
  it("defaults to the transaction validity window plus clock-skew margin", () => {
    expect(parseSubmissionTtlMs({})).toBe(DEFAULT_SUBMISSION_TTL_MS);
  });

  it("reads an operator override", () => {
    expect(
      parseSubmissionTtlMs({ MERIDIAN_KEEPER_SUBMISSION_TTL_MS: "90000" })
    ).toBe(90_000);
  });

  it("rejects a non-positive override rather than silently disabling the window", () => {
    expect(() =>
      parseSubmissionTtlMs({ MERIDIAN_KEEPER_SUBMISSION_TTL_MS: "0" })
    ).toThrow(/must be a positive integer/);
  });
});

describe("resolvePriorSubmission", () => {
  it("reports none when nothing was recorded", async () => {
    const result = await resolvePriorSubmission({
      store: memoryStore(),
      key: KEY,
      server: lookup({ status: "NOT_FOUND" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
    });

    expect(result).toEqual({ state: "none" });
  });

  it("clears the record when the recorded transaction confirmed successfully", async () => {
    const store = memoryStore({
      [KEY]: { hash: "HASH", submittedAtMs: Date.now() },
    });

    const result = await resolvePriorSubmission({
      store,
      key: KEY,
      server: lookup({ status: "SUCCESS", ledger: 42 }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
    });

    expect(result).toEqual({ state: "landed", hash: "HASH", ledger: 42 });
    expect(await store.get(KEY)).toBeNull();
  });

  it("clears the record and allows an immediate retry when the transaction failed on-chain", async () => {
    const store = memoryStore({
      [KEY]: { hash: "HASH", submittedAtMs: Date.now() },
    });

    const result = await resolvePriorSubmission({
      store,
      key: KEY,
      server: lookup({ status: "FAILED" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
    });

    expect(result).toEqual({ state: "failed", hash: "HASH" });
    expect(await store.get(KEY)).toBeNull();
  });

  it("keeps blocking while an unfound transaction is still inside its validity window", async () => {
    const now = 1_000_000;
    const store = memoryStore({
      [KEY]: { hash: "HASH", submittedAtMs: now - 5_000 },
    });

    const result = await resolvePriorSubmission({
      store,
      key: KEY,
      server: lookup({ status: "NOT_FOUND" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
      now,
    });

    expect(result).toEqual({ state: "in-flight", hash: "HASH", ageMs: 5_000 });
    expect(await store.get(KEY)).not.toBeNull();
  });

  it("ages out an unfound transaction that can no longer land, so nothing waits on a human", async () => {
    // Soroban transactions are built with bounded time bounds; past that
    // window the transaction is provably dead however NOT_FOUND reads.
    const now = 1_000_000;
    const store = memoryStore({
      [KEY]: {
        hash: "HASH",
        submittedAtMs: now - DEFAULT_SUBMISSION_TTL_MS - 1,
      },
    });

    const result = await resolvePriorSubmission({
      store,
      key: KEY,
      server: lookup({ status: "NOT_FOUND" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
      now,
    });

    expect(result).toEqual({ state: "expired", hash: "HASH" });
    expect(await store.get(KEY)).toBeNull();
  });

  it("treats an unreadable store as unknown, never as 'nothing was submitted'", async () => {
    const log = logger();
    const store: KeeperStateStore = {
      get: async () => {
        throw new Error("KV unavailable");
      },
      set: async () => undefined,
      delete: async () => undefined,
    };

    const result = await resolvePriorSubmission({
      store,
      key: KEY,
      server: lookup({ status: "NOT_FOUND" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: log,
    });

    expect(result).toMatchObject({ state: "unknown" });
    expect(log.warn).toHaveBeenCalledWith(
      "[keeper-state] could not read prior submission record",
      expect.objectContaining({ error: "KV unavailable" })
    );
  });

  it("treats a failed status lookup as unknown rather than assuming the transaction is dead", async () => {
    const store = memoryStore({
      [KEY]: { hash: "HASH", submittedAtMs: Date.now() },
    });

    const result = await resolvePriorSubmission({
      store,
      key: KEY,
      server: {
        getTransaction: vi.fn(async () => {
          throw new Error("rpc unavailable");
        }),
      },
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
    });

    expect(result).toMatchObject({ state: "unknown" });
    // Still recorded: the run couldn't prove anything either way.
    expect(await store.get(KEY)).not.toBeNull();
  });

  it("blocks on an unrecognised status instead of treating it as resolved", async () => {
    const result = await resolvePriorSubmission({
      store: memoryStore({
        [KEY]: { hash: "HASH", submittedAtMs: Date.now() },
      }),
      key: KEY,
      server: lookup({ status: "PENDING_SOMETHING_NEW" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
    });

    expect(result).toMatchObject({ state: "in-flight" });
  });
});

describe("recordSubmission and clearSubmission", () => {
  it("never throws when the store write fails, since the transaction is already broadcast", async () => {
    // Throwing here would surface as a submission error, and the retry loop
    // answers those by broadcasting a second transaction, the exact
    // duplicate this module exists to prevent.
    const log = logger();
    const store: KeeperStateStore = {
      get: async () => null,
      set: async () => {
        throw new Error("KV write failed");
      },
      delete: async () => {
        throw new Error("KV delete failed");
      },
    };

    await expect(
      recordSubmission(store, KEY, "HASH", 1_000, log)
    ).resolves.toBeUndefined();
    await expect(clearSubmission(store, KEY, log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("stamps the record with the submission time", async () => {
    const store = memoryStore();
    await recordSubmission(store, KEY, "HASH", 1_000, logger(), {}, 1234);
    expect(await store.get(KEY)).toEqual({ hash: "HASH", submittedAtMs: 1234 });
  });
});

describe("createInMemoryKeeperStateStore", () => {
  it("expires a record once its TTL has passed", async () => {
    vi.useFakeTimers();
    try {
      const store = createInMemoryKeeperStateStore();
      await store.set(KEY, { hash: "HASH", submittedAtMs: Date.now() }, 1_000);
      expect(await store.get(KEY)).not.toBeNull();
      vi.advanceTimersByTime(1_001);
      expect(await store.get(KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a record on request", async () => {
    const store = createInMemoryKeeperStateStore();
    await store.set(KEY, { hash: "HASH", submittedAtMs: 1 }, 1_000);
    await store.delete(KEY);
    expect(await store.get(KEY)).toBeNull();
  });
});

describe("createUpstashKeeperStateStore", () => {
  function fetchMock(response: unknown, ok = true, status = 200) {
    return vi.fn(async () => ({
      ok,
      status,
      json: async () => response,
    })) as unknown as typeof fetch;
  }

  it("reads a record back through the REST API", async () => {
    const fetchImpl = fetchMock({
      result: JSON.stringify({ hash: "HASH", submittedAtMs: 5 }),
    });
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example/",
      token: "tok",
      fetchImpl,
    });

    expect(await store.get(KEY)).toEqual({ hash: "HASH", submittedAtMs: 5 });
    expect(fetchImpl).toHaveBeenCalledWith(
      // Trailing slash trimmed, so the command never posts to a double-slash path.
      "https://redis.example",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(["GET", KEY]),
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      })
    );
  });

  it("writes with a millisecond expiry so a lost record cannot outlive its transaction", async () => {
    const fetchImpl = fetchMock({ result: "OK" });
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl,
    });

    await store.set(KEY, { hash: "HASH", submittedAtMs: 5 }, 1_500);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({
        body: JSON.stringify([
          "SET",
          KEY,
          JSON.stringify({ hash: "HASH", submittedAtMs: 5 }),
          "PX",
          1500,
        ]),
      })
    );
  });

  it("deletes through DEL", async () => {
    const fetchImpl = fetchMock({ result: 1 });
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl,
    });

    await store.delete(KEY);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({ body: JSON.stringify(["DEL", KEY]) })
    );
  });

  it("treats an unparseable or malformed stored value as no record", async () => {
    const garbage = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl: fetchMock({ result: "not json" }),
    });
    expect(await garbage.get(KEY)).toBeNull();

    const wrongShape = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl: fetchMock({ result: JSON.stringify({ hash: 7 }) }),
    });
    expect(await wrongShape.get(KEY)).toBeNull();

    const missing = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl: fetchMock({ result: null }),
    });
    expect(await missing.get(KEY)).toBeNull();
  });

  it("reports an HTTP failure by status alone, never echoing the credential", async () => {
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "super-secret-token",
      fetchImpl: fetchMock({}, false, 503),
    });

    await expect(store.get(KEY)).rejects.toThrow(
      "Upstash Redis request failed with HTTP 503"
    );
    await expect(store.get(KEY)).rejects.not.toThrow(/super-secret-token/);
  });

  it("surfaces a Redis-level error response", async () => {
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl: fetchMock({ error: "WRONGTYPE" }),
    });

    await expect(store.get(KEY)).rejects.toThrow(
      "Upstash Redis error: WRONGTYPE"
    );
  });
});

describe("loadKeeperStateStore", () => {
  it("uses Upstash when the same credentials the rate limiter uses are present", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
    })) as unknown as typeof fetch;

    const store = loadKeeperStateStore(
      {
        UPSTASH_REDIS_REST_URL: "https://redis.example",
        UPSTASH_REDIS_REST_TOKEN: "tok",
      },
      { keeper: "migration", requireShared: true, logger: logger(), fetchImpl }
    );
    await store.get(KEY);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses to run the migration keeper in production without a shared store", () => {
    // A per-invocation fallback cannot dedup across invocations at all, and
    // a duplicate migrate_adapter costs real slippage twice.
    expect(() =>
      loadKeeperStateStore(
        { VERCEL_ENV: "production" },
        { keeper: "migration", requireShared: true, logger: logger() }
      )
    ).toThrow(
      /UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required/
    );
  });

  it("lets the accrue keeper fall back in production, since a duplicate accrue only costs a fee", () => {
    const log = logger();
    const store = loadKeeperStateStore(
      { VERCEL_ENV: "production" },
      { keeper: "accrual", requireShared: false, logger: log }
    );

    expect(store).toBeDefined();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("cross-invocation dedup is inactive"),
      { store: "in-memory" }
    );
  });

  it("falls back outside production even for the migration keeper", () => {
    expect(
      loadKeeperStateStore(
        { VERCEL_ENV: "preview" },
        { keeper: "migration", requireShared: true, logger: logger() }
      )
    ).toBeDefined();
  });

  it("ignores blank credentials rather than building a store that cannot work", () => {
    const log = logger();
    loadKeeperStateStore(
      { UPSTASH_REDIS_REST_URL: "  ", UPSTASH_REDIS_REST_TOKEN: "tok" },
      { keeper: "accrual", requireShared: false, logger: log }
    );
    expect(log.info).toHaveBeenCalled();
  });
});
