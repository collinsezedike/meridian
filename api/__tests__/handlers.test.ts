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
import {
  buildDepositTx,
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

beforeEach(() => vi.clearAllMocks());

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
  it("returns the vault list with a CDN cache header", async () => {
    const res = makeRes();
    await vaultsHandler(fakeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toContain("s-maxage=60");
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
