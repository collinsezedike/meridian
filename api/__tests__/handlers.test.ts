import { describe, it, expect, vi, beforeEach } from "vitest";
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
    allowedAdapterIds: ["CADAPTER"],
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
import { resetRateLimitForTesting } from "../_lib/middleware.js";

// A 56-char Stellar public key shape (only the length is validated).
const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const fakeReq = (obj: object) =>
  ({ headers: {}, ...obj }) as unknown as VercelRequest;

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  ended: boolean;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  end(): FakeRes;
  setHeader(key: string, value: string): void;
}

function makeRes(): FakeRes & VercelResponse {
  const r: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(payload: unknown) {
      r.body = payload;
      return r;
    },
    end() {
      r.ended = true;
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
  resetRateLimitForTesting();
  process.env.CRON_SECRET = "cron-secret";
  delete process.env.VERCEL_ENV;
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
  it("applies CORS and handles preflight before auth", async () => {
    const res = makeRes();
    await keeperHandler(fakeReq({ method: "OPTIONS", headers: {} }), res);

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeDefined();
    expect(runBlendAccrualKeeper).not.toHaveBeenCalled();
  });

  it("rejects requests without the cron bearer token", async () => {
    const res = makeRes();
    await keeperHandler(fakeReq({ method: "GET", headers: {} }), res);

    expect(res.statusCode).toBe(401);
    expect(runBlendAccrualKeeper).not.toHaveBeenCalled();
  });

  it("rejects production requests with the wrong cron bearer token", async () => {
    process.env.VERCEL_ENV = "production";
    const res = makeRes();
    await keeperHandler(
      fakeReq({ method: "GET", headers: { authorization: "Bearer wrong" } }),
      res
    );

    expect(res.statusCode).toBe(401);
    expect(runBlendAccrualKeeper).not.toHaveBeenCalled();
  });

  it.each([
    ["production", "production"],
    ["preview", "preview"],
    ["local", undefined],
  ])("fails closed when CRON_SECRET is not configured in %s", async (
    _label,
    vercelEnv
  ) => {
    delete process.env.CRON_SECRET;
    if (vercelEnv) {
      process.env.VERCEL_ENV = vercelEnv;
    } else {
      delete process.env.VERCEL_ENV;
    }
    vi.spyOn(console, "error").mockImplementationOnce(() => undefined);

    const res = makeRes();
    await keeperHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "CRON_SECRET is not configured" });
    expect(runBlendAccrualKeeper).not.toHaveBeenCalled();
  });

  it("runs in Vercel production only with the configured cron secret", async () => {
    process.env.VERCEL_ENV = "production";
    const res = makeRes();
    await keeperHandler(
      fakeReq({
        method: "POST",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(runBlendAccrualKeeper).toHaveBeenCalledOnce();
  });

  it("runs in Vercel preview when the cron secret is configured", async () => {
    process.env.VERCEL_ENV = "preview";
    const res = makeRes();
    await keeperHandler(
      fakeReq({
        method: "GET",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(runBlendAccrualKeeper).toHaveBeenCalledOnce();
  });

  it("rejects incorrect HTTP methods with 405", async () => {
    const res = makeRes();
    await keeperHandler(
      fakeReq({
        method: "PUT",
        headers: { authorization: "Bearer cron-secret" },
      }),
      res
    );

    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET, POST");
    expect(runBlendAccrualKeeper).not.toHaveBeenCalled();
  });

  it("enforces the shared rate limit before running the keeper", async () => {
    const headers = {
      authorization: "Bearer cron-secret",
      "x-forwarded-for": "203.0.113.10",
    };

    for (let i = 0; i < 100; i++) {
      await keeperHandler(fakeReq({ method: "GET", headers }), makeRes());
    }

    const res = makeRes();
    await keeperHandler(fakeReq({ method: "GET", headers }), res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: "Too many requests. Try again in a minute.",
    });
    expect(runBlendAccrualKeeper).toHaveBeenCalledTimes(100);
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
});
