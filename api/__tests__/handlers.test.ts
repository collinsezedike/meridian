import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.mock("../_lib/middleware.js", async () => {
  const actual = await vi.importActual<typeof import("../_lib/middleware.js")>(
    "../_lib/middleware.js"
  );
  return {
    ...actual,
    checkRateLimit: vi.fn(
      async (...args: Parameters<typeof actual.checkRateLimit>) =>
        actual.checkRateLimit(...args)
    ),
  };
});

// Stub the workspace builders/readers — these tests exercise the HTTP handler
// contract (method guards, field validation, status codes, payload shape), not
// the Soroban transaction building, which is unit-tested in the helpers package.
vi.mock("@meridian/stellar-sdk-helpers", () => ({
  redactedErrorMessage: vi.fn((err: unknown) => {
    if (!(err instanceof Error)) return "Keeper operation failed";
    const first = err.message.split("\n")[0]?.trim();
    if (!first || /https?:\/\/|C[A-Z2-7]{50,}/.test(first))
      return "Keeper operation failed";
    return first;
  }),
  buildDepositTx: vi.fn(async () => ({ xdr: "DEPOSIT_XDR", fee: "100" })),
  buildWithdrawTx: vi.fn(async () => ({ xdr: "WITHDRAW_XDR", fee: "100" })),
  buildAddTrustlineTx: vi.fn(async () => ({ xdr: "TRUST_XDR" })),
  submitTx: vi.fn(async () => ({ hash: "HASH" })),
  loadBlendAccrualKeeperConfig: vi.fn(() => ({
    network: {
      network: "testnet",
      rpcUrl: "https://rpc.example",
      passphrase: "Test SDF Network ; September 2015",
    },
    secretKey: "SECRET",
    maxAttempts: 3,
    baseDelayMs: 1,
    rpcTimeoutMs: 100,
  })),
  runBlendAccrualKeeper: vi.fn(async () => ({
    network: "testnet",
    startedAt: "2026-08-06T00:00:00.000Z",
    finishedAt: "2026-08-06T00:00:01.000Z",
    discoveredAdapters: 1,
    blendAdapters: 1,
    successes: [
      {
        vaultId: "meridian-usdc",
        adapterId: "CADAPTER",
        hash: "HASH",
        ledger: 123,
        attempts: 1,
      },
    ],
    skipped: [],
    failures: [],
  })),
  isMigrationKeeperConfigured: vi.fn(
    (env: Record<string, string | undefined>) =>
      Boolean(env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY?.trim())
  ),
  loadMigrationKeeperConfig: vi.fn(() => ({
    network: {
      network: "testnet",
      rpcUrl: "https://rpc.example",
      passphrase: "Test SDF Network ; September 2015",
    },
    secretKey: "SECRET",
    maxAttempts: 3,
    baseDelayMs: 1,
    rpcTimeoutMs: 100,
    minImprovementBps: 50,
    maxSlippageBps: 100,
    candidateAdapters: {},
  })),
  runMigrationKeeper: vi.fn(async () => ({
    network: "testnet",
    startedAt: "2026-08-06T00:00:00.000Z",
    finishedAt: "2026-08-06T00:00:01.000Z",
    discoveredVaults: 1,
    migrations: [],
    skipped: [{ vaultId: "meridian-usdc", reason: "current rate unavailable" }],
    failures: [],
  })),
  fetchAllVaults: vi.fn(async () => [
    { id: "blend-usdc-fixed", protocol: "blend" },
  ]),
  selectBestVault: vi.fn(() => ({ id: "blend-usdc-fixed" })),
  isVaultCacheWarm: vi.fn(() => false),
  resolvePositions: vi.fn(async () => [
    {
      vaultId: "blend-usdc-fixed",
      shares: 1,
      deposited: 1,
      earned: 0,
      entryTime: 0,
    },
  ]),
  consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loadKeeperHeartbeatStore: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
  })),
  recordKeeperHeartbeat: vi.fn(async () => {}),
  getKeeperHeartbeat: vi.fn(async () => null),
  isKeeperHealthy: vi.fn(() => false),
  KEEPER_SCHEDULE_MS: { accrual: 15 * 60_000, migration: 60 * 60_000 },
  KNOWN_POOLS: {
    testnet: {
      "meridian-usdc": {
        id: "meridian-usdc",
        name: "Meridian",
        protocol: "meridian",
        label: "USDC Vault",
        contractId: "CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL",
        assetId: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
        asset: "USDC",
      },
    },
    mainnet: {},
  },
  fetchCoordinatorState: vi.fn(async () => ({
    protocol: "blend",
    adapterId: "CADAPTER",
    totalShares: 1000,
    totalAssets: 1050,
    paused: false,
  })),
}));

import depositHandler from "../v1/tx/deposit";
import withdrawHandler from "../v1/tx/withdraw";
import trustlineHandler from "../v1/tx/add-trustline";
import submitHandler from "../v1/tx/submit";
import vaultsHandler from "../v1/vaults/index";
import positionsHandler from "../v1/positions/[publicKey]";
import keeperHandler from "../v1/keepers/accrue";
import rebalanceHandler from "../v1/keepers/rebalance";
import keeperHealthHandler from "../v1/keepers/health";
import vaultStateHandler from "../v1/admin/vault-state";
import {
  checkRateLimit,
  resetRateLimitForTesting,
} from "../_lib/middleware.js";
import {
  buildDepositTx,
  buildWithdrawTx,
  runBlendAccrualKeeper,
  runMigrationKeeper,
  resolvePositions,
  recordKeeperHeartbeat,
  getKeeperHeartbeat,
  isKeeperHealthy,
  fetchCoordinatorState,
} from "@meridian/stellar-sdk-helpers";

// A 56-char Stellar public key shape (only the length is validated).
const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const fakeReq = (obj: object) =>
  ({ headers: {}, ...obj }) as unknown as VercelRequest;

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  setHeader(key: string, value: string): void;
}

function makeRes(): FakeRes & VercelResponse {
  const r: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(payload: unknown) {
      r.body = payload;
      return r;
    },
    setHeader(key: string, value: string) {
      r.headers[key] = value;
    },
  };
  return r as unknown as FakeRes & VercelResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret";
  process.env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY = "S".repeat(56);
});

describe("POST /api/v1/tx/deposit", () => {
  it("returns 503 when the upstream rate limiter fails", async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(
      new Error("Upstash timeout")
    );

    const res = makeRes();
    await depositHandler(
      fakeReq({
        method: "POST",
        body: {
          walletAddress: PUBKEY,
          vaultId: "blend-usdc-fixed",
          amount: "10",
        },
      }),
      res
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "Rate limiter unavailable; refusing to run",
    });
  });

  it("rejects non-POST methods with 405", async () => {
    const res = makeRes();
    await depositHandler(fakeReq({ method: "GET", body: {} }), res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 listing the missing fields", async () => {
    const res = makeRes();
    await depositHandler(
      fakeReq({ method: "POST", body: { walletAddress: PUBKEY } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error:
        "vaultId: Invalid input: expected string, received undefined; amount: Invalid input: expected string, received undefined",
    });
  });

  it("builds the deposit transaction and returns the XDR", async () => {
    const res = makeRes();
    await depositHandler(
      fakeReq({
        method: "POST",
        body: {
          walletAddress: PUBKEY,
          vaultId: "blend-usdc-fixed",
          amount: "10",
        },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ xdr: "DEPOSIT_XDR", fee: "100" });
    expect(buildDepositTx).toHaveBeenCalledOnce();
  });

  it("accepts and forwards min_shares_out in deposit request", async () => {
    const res = makeRes();
    await depositHandler(
      fakeReq({
        method: "POST",
        body: {
          walletAddress: PUBKEY,
          vaultId: "blend-usdc-fixed",
          amount: "10",
          min_shares_out: "9.5",
        },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(buildDepositTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "10",
      expect.anything(),
      "9.5"
    );
  });

  it("surfaces builder errors as 500", async () => {
    vi.mocked(buildDepositTx).mockRejectedValueOnce(
      new Error("USDC trustline missing")
    );
    const res = makeRes();
    await depositHandler(
      fakeReq({
        method: "POST",
        body: {
          walletAddress: PUBKEY,
          vaultId: "blend-usdc-fixed",
          amount: "10",
        },
      }),
      res
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "USDC trustline missing" });
  });
});

describe("POST /api/v1/tx/withdraw", () => {
  it("returns 400 when shares is missing", async () => {
    const res = makeRes();
    await withdrawHandler(
      fakeReq({
        method: "POST",
        body: { walletAddress: PUBKEY, vaultId: "v" },
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "shares: Invalid input: expected string, received undefined",
    });
  });

  it("builds the withdraw transaction", async () => {
    const res = makeRes();
    await withdrawHandler(
      fakeReq({
        method: "POST",
        body: {
          walletAddress: PUBKEY,
          vaultId: "blend-usdc-fixed",
          shares: "5",
        },
      }),
      res
    );
    expect(res.body).toEqual({ xdr: "WITHDRAW_XDR", fee: "100" });
  });

  it("accepts and forwards min_usdc_out in withdraw request", async () => {
    const res = makeRes();
    await withdrawHandler(
      fakeReq({
        method: "POST",
        body: {
          walletAddress: PUBKEY,
          vaultId: "blend-usdc-fixed",
          shares: "5",
          min_usdc_out: "4.8",
        },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(buildWithdrawTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "5",
      expect.anything(),
      "4.8"
    );
  });
});

describe("POST /api/v1/tx/add-trustline", () => {
  it("returns 400 without a wallet address", async () => {
    const res = makeRes();
    await trustlineHandler(fakeReq({ method: "POST", body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns the trustline XDR", async () => {
    const res = makeRes();
    await trustlineHandler(
      fakeReq({ method: "POST", body: { walletAddress: PUBKEY } }),
      res
    );
    expect(res.body).toEqual({ xdr: "TRUST_XDR" });
  });
});

describe("POST /api/v1/tx/submit", () => {
  it("returns 400 without an xdr", async () => {
    const res = makeRes();
    await submitHandler(fakeReq({ method: "POST", body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it("submits and returns the tx hash", async () => {
    const res = makeRes();
    await submitHandler(
      fakeReq({ method: "POST", body: { xdr: "SIGNED" } }),
      res
    );
    expect(res.body).toEqual({ hash: "HASH" });
  });
});

describe("GET /api/v1/vaults", () => {
  it("returns the vault list with no-store on testnet (APP_NETWORK default in tests)", async () => {
    const res = makeRes();
    await vaultsHandler(fakeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      vaults: [{ id: "blend-usdc-fixed" }],
      recommendedVaultId: "blend-usdc-fixed",
      cached: false,
    });
  });
});

describe("GET /api/v1/positions/:publicKey", () => {
  it("rejects a malformed public key with 400", async () => {
    const res = makeRes();
    await positionsHandler(
      fakeReq({ method: "GET", query: { publicKey: "too-short" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(resolvePositions).not.toHaveBeenCalled();
  });

  it("returns the resolved positions for a valid key", async () => {
    const res = makeRes();
    await positionsHandler(
      fakeReq({ method: "GET", query: { publicKey: PUBKEY } }),
      res
    );
    expect(res.body).toEqual({
      positions: [
        {
          vaultId: "blend-usdc-fixed",
          shares: 1,
          deposited: 1,
          earned: 0,
          entryTime: 0,
        },
      ],
    });
    expect(resolvePositions).toHaveBeenCalledOnce();
  });

  it("returns 503 when the Blend read throws", async () => {
    vi.mocked(resolvePositions).mockRejectedValueOnce(new Error("rpc down"));
    const res = makeRes();
    await positionsHandler(
      fakeReq({ method: "GET", query: { publicKey: PUBKEY } }),
      res
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "Failed to read positions" });
  });
});

describe("GET /api/v1/keepers/accrue", () => {
  it("rejects requests without the cron bearer token", async () => {
    const res = makeRes();
    await keeperHandler(fakeReq({ method: "GET", headers: {} }), res);

    expect(res.statusCode).toBe(401);
    expect(runBlendAccrualKeeper).not.toHaveBeenCalled();
  });

  it("still rate-limits requests that fail auth, not just successful ones", async () => {
    // Regression test: rate-limiting must run before auth, not after.
    // Unauthenticated/wrong-token spam that returns 401 before the limiter
    // ever runs would be completely unbounded, since 401 responses would
    // never count toward the limit.
    resetRateLimitForTesting();
    const ip = "203.0.113.50";
    let lastRes = makeRes();
    for (let i = 0; i < 101; i++) {
      lastRes = makeRes();
      await keeperHandler(
        fakeReq({
          method: "GET",
          headers: { "x-forwarded-for": ip },
        }),
        lastRes
      );
    }

    expect(lastRes.statusCode).toBe(429);
    resetRateLimitForTesting();
  });

  it("runs the accrual keeper for authorized cron calls", async () => {
    const res = makeRes();
    await keeperHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ successes: [{ hash: "HASH" }] });
    expect(runBlendAccrualKeeper).toHaveBeenCalledOnce();
    expect(recordKeeperHeartbeat).toHaveBeenCalledWith(
      expect.anything(),
      "accrual",
      expect.any(String),
      expect.anything()
    );
  });

  it("returns 500 when a submission fails so the cron run is observable", async () => {
    vi.mocked(runBlendAccrualKeeper).mockResolvedValueOnce({
      network: "testnet",
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:01.000Z",
      discoveredAdapters: 1,
      blendAdapters: 1,
      successes: [],
      skipped: [],
      failures: [
        {
          vaultId: "meridian-usdc",
          adapterId: "CADAPTER",
          stage: "submit",
          attempts: 3,
          transient: true,
          error: "try again later",
        },
      ],
    });

    const res = makeRes();
    await keeperHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      failures: [{ vaultId: "meridian-usdc", error: "try again later" }],
    });
    expect(recordKeeperHeartbeat).not.toHaveBeenCalled();
  });

  it("redacts an unexpected keeper-run error instead of leaking it raw", async () => {
    vi.mocked(runBlendAccrualKeeper).mockRejectedValueOnce(
      new Error("connect ECONNREFUSED https://rpc.internal.example:443")
    );

    const res = makeRes();
    await keeperHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Keeper operation failed" });
  });

  describe("without CRON_SECRET configured", () => {
    const savedVercelEnv = process.env.VERCEL_ENV;
    const savedNodeEnv = process.env.NODE_ENV;

    beforeEach(() => {
      delete process.env.CRON_SECRET;
    });

    afterEach(() => {
      process.env.CRON_SECRET = "cron-secret";
      if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = savedVercelEnv;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    });

    it("fails closed (503) when VERCEL_ENV is production, regardless of NODE_ENV", async () => {
      // Vercel serverless functions don't reliably set NODE_ENV=production
      // the way traditional Node apps do; VERCEL_ENV is the platform's own
      // signal. NODE_ENV is deliberately left unset here to prove the gate
      // no longer depends on it.
      delete process.env.NODE_ENV;
      process.env.VERCEL_ENV = "production";

      const res = makeRes();
      await keeperHandler(fakeReq({ method: "GET", headers: {} }), res);

      expect(res.statusCode).toBe(503);
      expect(runBlendAccrualKeeper).not.toHaveBeenCalled();
    });

    it("permits unauthenticated calls outside production (local dev)", async () => {
      delete process.env.VERCEL_ENV;
      delete process.env.NODE_ENV;

      const res = makeRes();
      await keeperHandler(fakeReq({ method: "GET", headers: {} }), res);

      expect(res.statusCode).toBe(200);
      expect(runBlendAccrualKeeper).toHaveBeenCalledOnce();
    });

    it("fails closed (503) on preview deployments too, unlike simple rate-limit relaxation elsewhere", async () => {
      // This endpoint triggers real signed transactions off the keeper's
      // funded account, unlike middleware.ts's rate-limit fallback, so an
      // unauthenticated preview caller could drain that account by spamming
      // the endpoint. Preview deploys have their own public URL, so this
      // must not be treated as equivalent to local dev.
      process.env.VERCEL_ENV = "preview";

      const res = makeRes();
      await keeperHandler(fakeReq({ method: "GET", headers: {} }), res);

      expect(res.statusCode).toBe(503);
      expect(runBlendAccrualKeeper).not.toHaveBeenCalled();
    });
  });
});

describe("GET /api/v1/keepers/rebalance", () => {
  it("reports disabled instead of a noisy 500 when the migration secret key isn't configured", async () => {
    delete process.env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY;
    const res = makeRes();
    await rebalanceHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "disabled" });
    expect(runMigrationKeeper).not.toHaveBeenCalled();
  });

  it("rejects requests without the cron bearer token", async () => {
    const res = makeRes();
    await rebalanceHandler(fakeReq({ method: "GET", headers: {} }), res);

    expect(res.statusCode).toBe(401);
    expect(runMigrationKeeper).not.toHaveBeenCalled();
  });

  it("still rate-limits requests that fail auth, not just successful ones", async () => {
    // Same regression as the accrue keeper's equivalent test, higher
    // stakes here: this endpoint holds full vault admin authority.
    resetRateLimitForTesting();
    const ip = "203.0.113.51";
    let lastRes = makeRes();
    for (let i = 0; i < 101; i++) {
      lastRes = makeRes();
      await rebalanceHandler(
        fakeReq({
          method: "GET",
          headers: { "x-forwarded-for": ip },
        }),
        lastRes
      );
    }

    expect(lastRes.statusCode).toBe(429);
    resetRateLimitForTesting();
  });

  it("runs the migration keeper for authorized cron calls", async () => {
    const res = makeRes();
    await rebalanceHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      skipped: [
        { vaultId: "meridian-usdc", reason: "current rate unavailable" },
      ],
    });
    expect(runMigrationKeeper).toHaveBeenCalledOnce();
    expect(recordKeeperHeartbeat).toHaveBeenCalledWith(
      expect.anything(),
      "migration",
      expect.any(String),
      expect.anything()
    );
  });

  it("returns 500 when a migration fails so the cron run is observable", async () => {
    vi.mocked(runMigrationKeeper).mockResolvedValueOnce({
      network: "testnet",
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:01.000Z",
      discoveredVaults: 1,
      migrations: [],
      skipped: [],
      failures: [
        {
          vaultId: "meridian-usdc",
          adapterId: "CDEFINDEXADAPTER",
          stage: "submit",
          attempts: 3,
          transient: true,
          error: "try again later",
        },
      ],
    });

    const res = makeRes();
    await rebalanceHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      failures: [{ vaultId: "meridian-usdc", error: "try again later" }],
    });
    expect(recordKeeperHeartbeat).not.toHaveBeenCalled();
  });

  it("redacts an unexpected keeper-run error instead of leaking it raw", async () => {
    vi.mocked(runMigrationKeeper).mockRejectedValueOnce(
      new Error("connect ECONNREFUSED https://rpc.internal.example:443")
    );

    const res = makeRes();
    await rebalanceHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Keeper operation failed" });
  });
});

describe("GET /api/v1/keepers/health", () => {
  it("is public — no cron bearer token required", async () => {
    const res = makeRes();
    await keeperHealthHandler(fakeReq({ method: "GET", headers: {} }), res);

    expect(res.statusCode).toBe(200);
  });

  it("reports both keepers with their health flag and interval", async () => {
    vi.mocked(getKeeperHeartbeat).mockImplementation(async (_store, id) =>
      id === "accrual" ? Date.now() : null
    );
    vi.mocked(isKeeperHealthy).mockImplementation((id) => id === "accrual");

    const res = makeRes();
    await keeperHealthHandler(fakeReq({ method: "GET", headers: {} }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { keepers: Array<Record<string, unknown>> };
    expect(body.keepers).toHaveLength(2);
    expect(body.keepers.find((k) => k.id === "accrual")).toMatchObject({
      healthy: true,
    });
    expect(body.keepers.find((k) => k.id === "migration")).toMatchObject({
      healthy: false,
      lastSuccessMs: null,
    });
  });
});

describe("GET /api/v1/admin/vault-state", () => {
  it("is public — no cron bearer token required", async () => {
    const res = makeRes();
    await vaultStateHandler(fakeReq({ method: "GET", headers: {} }), res);

    expect(res.statusCode).toBe(200);
  });

  it("returns the coordinator vault's on-chain state", async () => {
    const res = makeRes();
    await vaultStateHandler(fakeReq({ method: "GET", headers: {} }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      protocol: "blend",
      adapterId: "CADAPTER",
      totalShares: 1000,
      totalAssets: 1050,
      paused: false,
    });
  });

  it("returns 503 when the on-chain read fails", async () => {
    vi.mocked(fetchCoordinatorState).mockRejectedValueOnce(
      new Error("rpc unavailable")
    );

    const res = makeRes();
    await vaultStateHandler(fakeReq({ method: "GET", headers: {} }), res);

    expect(res.statusCode).toBe(503);
  });
});
