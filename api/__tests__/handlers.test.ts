import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Stub the workspace builders/readers — these tests exercise the HTTP handler
// contract (method guards, field validation, status codes, payload shape), not
// the Soroban transaction building, which is unit-tested in the helpers package.
vi.mock("@meridian/stellar-sdk-helpers", () => ({
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
}));

import depositHandler from "../v1/tx/deposit";
import withdrawHandler from "../v1/tx/withdraw";
import trustlineHandler from "../v1/tx/add-trustline";
import submitHandler from "../v1/tx/submit";
import vaultsHandler from "../v1/vaults/index";
import positionsHandler from "../v1/positions/[publicKey]";
import keeperHandler from "../v1/keepers/accrue";
import {
  buildDepositTx,
  runBlendAccrualKeeper,
  resolvePositions,
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
});

describe("POST /api/v1/tx/deposit", () => {
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
