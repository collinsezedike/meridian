import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_SUBMISSION_TTL_MS,
  createInMemoryKeeperStateStore,
  createUpstashKeeperStateStore,
  loadKeeperStateStore,
  parseSubmissionTtlMs,
  resolvePriorSubmission,
  serializeRecord,
  submissionStateKey,
  SubmissionLease,
  type KeeperStateStore,
  type SubmissionRecord,
} from "./keeper-state";
import { TX_VALIDITY_WINDOW_MS } from "./keeper-tx";
import type { KeeperLogger } from "./keeper-retry";

function logger(): KeeperLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const KEY = "meridian:keeper:migration:testnet:meridian-usdc";

async function seeded(record?: SubmissionRecord) {
  const store = createInMemoryKeeperStateStore();
  if (record) await store.claim(KEY, record, 600_000);
  return store;
}

function lookup(response: unknown) {
  return { getTransaction: vi.fn(async () => response as never) };
}

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
    expect(DEFAULT_SUBMISSION_TTL_MS).toBeGreaterThan(TX_VALIDITY_WINDOW_MS);
  });

  it("reads an operator override at or above the validity window", () => {
    expect(
      parseSubmissionTtlMs({ MERIDIAN_KEEPER_SUBMISSION_TTL_MS: "600000" })
    ).toBe(600_000);
  });

  it("rejects a TTL shorter than the transaction's own validity window", () => {
    // Anything shorter turns "aged out, so provably dead" into a duplicate
    // generator: the record clears while the transaction can still land.
    expect(() =>
      parseSubmissionTtlMs({ MERIDIAN_KEEPER_SUBMISSION_TTL_MS: "90000" })
    ).toThrow(/must be at least 300000/);
  });

  it("rejects a non-positive override", () => {
    expect(() =>
      parseSubmissionTtlMs({ MERIDIAN_KEEPER_SUBMISSION_TTL_MS: "0" })
    ).toThrow(/must be a positive integer/);
  });
});

describe("resolvePriorSubmission", () => {
  it("reports none when nothing was recorded", async () => {
    const result = await resolvePriorSubmission({
      store: await seeded(),
      key: KEY,
      server: lookup({ status: "NOT_FOUND" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
    });

    expect(result).toEqual({ state: "none" });
  });

  it("clears the record when the recorded transaction confirmed successfully", async () => {
    const store = await seeded({ hash: "HASH", updatedAtMs: Date.now() });

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
    const store = await seeded({ hash: "HASH", updatedAtMs: Date.now() });

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
    const store = await seeded({ hash: "HASH", updatedAtMs: now - 5_000 });

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
    const now = 1_000_000;
    const store = await seeded({
      hash: "HASH",
      updatedAtMs: now - DEFAULT_SUBMISSION_TTL_MS - 1,
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

  it("reports a hash-less claim as claimed, without touching the network", async () => {
    const server = lookup({ status: "NOT_FOUND" });
    const now = 1_000_000;

    const result = await resolvePriorSubmission({
      store: await seeded({ hash: null, updatedAtMs: now - 1_000 }),
      key: KEY,
      server,
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
      now,
    });

    expect(result).toEqual({ state: "claimed", ageMs: 1_000 });
    // Nothing was signed, so there is no hash to ask the network about.
    expect(server.getTransaction).not.toHaveBeenCalled();
  });

  it("ages a stale claim out on the short claim window, not the submission window", async () => {
    // A run that died mid-build never signed anything, so there is no
    // transaction that could still land; blocking for the full submission
    // TTL would be five minutes of nothing.
    const now = 1_000_000;
    const store = await seeded({
      hash: null,
      updatedAtMs: now - DEFAULT_CLAIM_TTL_MS - 1,
    });

    const result = await resolvePriorSubmission({
      store,
      key: KEY,
      server: lookup({ status: "NOT_FOUND" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
      now,
    });

    expect(result).toEqual({ state: "expired", hash: null });
    expect(await store.get(KEY)).toBeNull();
  });

  it("treats an unreadable store as unknown, never as 'nothing was submitted'", async () => {
    const log = logger();
    const store: KeeperStateStore = {
      ...(await seeded()),
      get: async () => {
        throw new Error("KV unavailable");
      },
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
    const store = await seeded({ hash: "HASH", updatedAtMs: Date.now() });

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

  it("bounds the status lookup instead of hanging the run on a black-holed connection", async () => {
    const result = await resolvePriorSubmission({
      store: await seeded({ hash: "HASH", updatedAtMs: Date.now() }),
      key: KEY,
      server: { getTransaction: () => new Promise(() => undefined) },
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      rpcTimeoutMs: 5,
      logger: logger(),
    });

    expect(result).toMatchObject({ state: "unknown" });
  });

  it("blocks on an unrecognised status instead of treating it as resolved", async () => {
    const result = await resolvePriorSubmission({
      store: await seeded({ hash: "HASH", updatedAtMs: Date.now() }),
      key: KEY,
      server: lookup({ status: "PENDING_SOMETHING_NEW" }),
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: logger(),
    });

    expect(result).toMatchObject({ state: "in-flight" });
  });

  it("leaves a record another run has replaced alone instead of clearing it", async () => {
    // The race this prevents: run A resolves an old hash as failed and
    // clears the key, run B has since written a new hash there, A's clear
    // wipes it, and run C sees a clean slate and rebroadcasts.
    const store = await seeded({ hash: "OLD_HASH", updatedAtMs: Date.now() });
    const log = logger();
    const server = {
      getTransaction: vi.fn(async () => {
        // B writes a newer record while A's lookup is in flight.
        const current = await store.get(KEY);
        await store.replace(
          KEY,
          { hash: "NEW_HASH", updatedAtMs: Date.now() },
          600_000,
          current!.revision
        );
        return { status: "FAILED" } as never;
      }),
    };

    const result = await resolvePriorSubmission({
      store,
      key: KEY,
      server,
      ttlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: log,
    });

    expect(result).toMatchObject({ state: "failed", hash: "OLD_HASH" });
    expect((await store.get(KEY))?.record.hash).toBe("NEW_HASH");
    expect(log.info).toHaveBeenCalledWith(
      "[keeper-state] record changed before it could be cleared",
      expect.any(Object)
    );
  });
});

describe("SubmissionLease", () => {
  async function acquire(store: KeeperStateStore, log = logger()) {
    return SubmissionLease.acquire({
      store,
      key: KEY,
      submissionTtlMs: DEFAULT_SUBMISSION_TTL_MS,
      logger: log,
    });
  }

  it("takes the target exclusively, so a concurrent run cannot also claim it", async () => {
    const store = await seeded();

    const first = await acquire(store);
    const second = await acquire(store);

    expect("lease" in first).toBe(true);
    expect(second).toMatchObject({
      error: expect.stringContaining("already holds"),
    });
  });

  it("refuses the lease when the store is unreachable", async () => {
    const store: KeeperStateStore = {
      ...(await seeded()),
      claim: async () => {
        throw new Error("KV unavailable");
      },
    };

    expect(await acquire(store)).toMatchObject({
      error: "submission state store unavailable",
    });
  });

  it("upgrades the claim to the signed hash and clears it once resolved", async () => {
    const store = await seeded();
    const acquired = await acquire(store);
    if (!("lease" in acquired)) throw new Error("expected a lease");

    await acquired.lease.hooks.onSigned?.("SIGNED");
    expect((await store.get(KEY))?.record.hash).toBe("SIGNED");

    await acquired.lease.hooks.onResolved?.("SIGNED");
    expect(await store.get(KEY)).toBeNull();
  });

  it("releases a claim that never became a signed transaction", async () => {
    const store = await seeded();
    const acquired = await acquire(store);
    if (!("lease" in acquired)) throw new Error("expected a lease");

    await acquired.lease.releaseIfUnsent();

    expect(await store.get(KEY)).toBeNull();
  });

  it("keeps a signed transaction's record when the run ends, rather than releasing it", async () => {
    const store = await seeded();
    const acquired = await acquire(store);
    if (!("lease" in acquired)) throw new Error("expected a lease");

    await acquired.lease.hooks.onSigned?.("SIGNED");
    await acquired.lease.releaseIfUnsent();

    expect((await store.get(KEY))?.record.hash).toBe("SIGNED");
  });

  it("stops touching the key after losing the lease to another run", async () => {
    // The claim expired and another run took the key: this run must not
    // overwrite or clear what now belongs to someone else.
    const store = await seeded();
    const log = logger();
    const acquired = await acquire(store, log);
    if (!("lease" in acquired)) throw new Error("expected a lease");

    const stolen: SubmissionRecord = { hash: "OTHER", updatedAtMs: Date.now() };
    const current = await store.get(KEY);
    await store.replace(KEY, stolen, 600_000, current!.revision);

    await acquired.lease.hooks.onSigned?.("SIGNED");
    expect((await store.get(KEY))?.record.hash).toBe("OTHER");
    expect(log.warn).toHaveBeenCalledWith(
      "[keeper-state] lost the submission lease",
      expect.any(Object)
    );

    await acquired.lease.hooks.onResolved?.("SIGNED");
    expect((await store.get(KEY))?.record.hash).toBe("OTHER");
  });

  it("never throws when the store write fails, since the transaction is already signed", async () => {
    // Throwing here would surface as a submission error, and the retry loop
    // answers those by broadcasting a second transaction.
    const log = logger();
    const inner = await seeded();
    const store: KeeperStateStore = {
      ...inner,
      replace: async () => {
        throw new Error("KV write failed");
      },
      deleteIf: async () => {
        throw new Error("KV delete failed");
      },
    };
    const acquired = await acquire(store, log);
    if (!("lease" in acquired)) throw new Error("expected a lease");

    await expect(
      acquired.lease.hooks.onSigned?.("SIGNED")
    ).resolves.toBeUndefined();
    await expect(
      acquired.lease.hooks.onResolved?.("SIGNED")
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("does not release a claim whose hash-write failed, so the record still blocks a duplicate", async () => {
    // The bug this guards against: a failed hash-write leaves the stored
    // claim hash-less, and `unsent` used to read true, so `releaseIfUnsent`
    // deleted the very record meant to block a second submission even though
    // a signed transaction may be in flight.
    const log = logger();
    const inner = await seeded();
    const store: KeeperStateStore = {
      ...inner,
      replace: async () => {
        throw new Error("KV write failed");
      },
    };
    const acquired = await acquire(store, log);
    if (!("lease" in acquired)) throw new Error("expected a lease");

    await acquired.lease.hooks.onSigned?.("SIGNED");
    await acquired.lease.releaseIfUnsent();

    // The claim must survive (still hash-less, still held) so the next run
    // reads it as claimed/expired rather than a clean slate to rebroadcast
    // into.
    expect(await store.get(KEY)).not.toBeNull();
    expect((await store.get(KEY))?.record.hash).toBeNull();
  });

  it("retries recording the signed hash instead of giving up on the first transient failure", async () => {
    // A swallowed one-shot failure here would leave the claim (short TTL, no
    // hash) as the only record of an actually in-flight transaction, aging
    // out well before the transaction itself could no longer land.
    const log = logger();
    const inner = await seeded();
    let attempts = 0;
    const store: KeeperStateStore = {
      ...inner,
      replace: async (...args) => {
        attempts += 1;
        if (attempts < 3) throw new Error("KV write failed");
        return inner.replace(...args);
      },
    };
    const acquired = await acquire(store, log);
    if (!("lease" in acquired)) throw new Error("expected a lease");

    await acquired.lease.hooks.onSigned?.("SIGNED");

    expect(attempts).toBe(3);
    expect((await store.get(KEY))?.record.hash).toBe("SIGNED");
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("createInMemoryKeeperStateStore", () => {
  it("expires a record once its TTL has passed", async () => {
    vi.useFakeTimers();
    try {
      const store = createInMemoryKeeperStateStore();
      await store.claim(KEY, { hash: "HASH", updatedAtMs: Date.now() }, 1_000);
      expect(await store.get(KEY)).not.toBeNull();
      vi.advanceTimersByTime(1_001);
      expect(await store.get(KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a conditional write whose expected revision no longer matches", async () => {
    const store = createInMemoryKeeperStateStore();
    const claimed = await store.claim(
      KEY,
      { hash: null, updatedAtMs: 1 },
      1_000
    );

    await store.replace(
      KEY,
      { hash: "A", updatedAtMs: 2 },
      1_000,
      claimed!.revision
    );

    expect(
      await store.replace(
        KEY,
        { hash: "B", updatedAtMs: 3 },
        1_000,
        claimed!.revision
      )
    ).toBeNull();
    expect(await store.deleteIf(KEY, claimed!.revision)).toBe(false);
    expect((await store.get(KEY))?.record.hash).toBe("A");
  });

  it("ignores a stored value that isn't a usable record", async () => {
    const store = createInMemoryKeeperStateStore();
    await store.claim(KEY, { hash: 7 as never, updatedAtMs: 1 }, 1_000);
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

  const RECORD: SubmissionRecord = { hash: "HASH", updatedAtMs: 5 };

  it("reads a record back through the REST API", async () => {
    const fetchImpl = fetchMock({ result: serializeRecord(RECORD) });
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example/",
      token: "tok",
      fetchImpl,
    });

    expect((await store.get(KEY))?.record).toEqual(RECORD);
    expect(fetchImpl).toHaveBeenCalledWith(
      // Trailing slash trimmed, so the command never posts to a double slash.
      "https://redis.example",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(["GET", KEY]),
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      })
    );
  });

  it("claims with SET NX and a millisecond expiry, and reports a lost race", async () => {
    const taken = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      // Upstash returns null for a SET NX that didn't apply.
      fetchImpl: fetchMock({ result: null }),
    });
    expect(await taken.claim(KEY, RECORD, 1_500)).toBeNull();

    const fetchImpl = fetchMock({ result: "OK" });
    const free = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl,
    });
    expect(await free.claim(KEY, RECORD, 1_500)).toMatchObject({
      record: RECORD,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({
        body: JSON.stringify([
          "SET",
          KEY,
          serializeRecord(RECORD),
          "NX",
          "PX",
          1500,
        ]),
      })
    );
  });

  it("makes replace and delete conditional on the stored value, not just the key", async () => {
    // A plain SET/DEL would let a slow run clobber a newer run's record.
    const fetchImpl = fetchMock({ result: 1 });
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl,
    });

    await store.replace(KEY, RECORD, 1_500, "OLD");
    await store.deleteIf(KEY, "OLD");

    const bodies = (
      fetchImpl as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(bodies[0]).toContain('"EVAL"');
    expect(bodies[0]).toContain("OLD");
    expect(bodies[1]).toContain('"EVAL"');
    expect(bodies[1]).toContain("OLD");
  });

  it("reports a conditional write that lost the race", async () => {
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl: fetchMock({ result: 0 }),
    });

    expect(await store.replace(KEY, RECORD, 1_500, "OLD")).toBeNull();
    expect(await store.deleteIf(KEY, "OLD")).toBe(false);
  });

  it("treats an unparseable or malformed stored value as no record", async () => {
    for (const result of [
      "not json",
      JSON.stringify({ hash: 7, updatedAtMs: 1 }),
      JSON.stringify({ hash: "H" }),
      null,
    ]) {
      const store = createUpstashKeeperStateStore({
        url: "https://redis.example",
        token: "tok",
        fetchImpl: fetchMock({ result }),
      });
      expect(await store.get(KEY)).toBeNull();
    }
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

  it("bounds a hung request instead of stalling the run past its budget", async () => {
    // The worst moment for an unbounded KV call is right after a
    // transaction was broadcast.
    const store = createUpstashKeeperStateStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl: (() =>
        new Promise(() => undefined)) as unknown as typeof fetch,
      timeoutMs: 5,
    });

    await expect(store.get(KEY)).rejects.toThrow(/timed out/);
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

  it("refuses to run the migration keeper on any deployment without a shared store", () => {
    // Preview counts: preview deployments sign real transactions off a real
    // key, and middleware.ts only fails closed on production, so this is
    // the guard that actually covers preview.
    for (const env of ["production", "preview"]) {
      expect(() =>
        loadKeeperStateStore(
          { VERCEL_ENV: env },
          { keeper: "migration", requireShared: true, logger: logger() }
        )
      ).toThrow(
        /UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required/
      );
    }
  });

  it("warns, not just informs, when a deployed accrue keeper falls back", () => {
    // Falling back reinstates the duplicate-submission gap; that belongs in
    // logs someone can alert on, not buried at info level.
    const log = logger();
    loadKeeperStateStore(
      { VERCEL_ENV: "production" },
      { keeper: "accrual", requireShared: false, logger: log }
    );

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("cross-invocation dedup is inactive"),
      { store: "in-memory", env: "production" }
    );
  });

  it("stays quiet at info level in local dev, where the fallback is expected", () => {
    const log = logger();
    loadKeeperStateStore(
      {},
      { keeper: "migration", requireShared: true, logger: log }
    );

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("cross-invocation dedup is inactive"),
      { store: "in-memory" }
    );
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
