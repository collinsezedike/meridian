import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { positionsRoute } from "../routes/positions.js";
import { txRoute } from "../routes/tx.js";
import { vaultsRoute } from "../routes/vaults.js";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  resolvePositions: vi.fn(),
  buildDepositTx: vi.fn(),
  buildWithdrawTx: vi.fn(),
  buildAddTrustlineTx: vi.fn(),
  submitTx: vi.fn(),
  fetchAllVaults: vi.fn(),
  selectBestVault: vi.fn(),
  isVaultCacheWarm: vi.fn(() => false),
}));

import {
  resolvePositions,
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
  fetchAllVaults,
  selectBestVault,
} from "@meridian/stellar-sdk-helpers";

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function buildApp() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));
  app.register(positionsRoute, { prefix: "/api/v1/positions" });
  app.register(txRoute, { prefix: "/api/v1/tx" });
  app.register(vaultsRoute, { prefix: "/api/v1/vaults" });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });
});

describe("GET /api/v1/positions/:publicKey", () => {
  it("returns 200 with positions from the SDK", async () => {
    const app = buildApp();
    const pos = [{ vaultId: "blend-usdc-fixed", shares: 10, deposited: 10, earned: 0, entryTime: 0 }];
    vi.mocked(resolvePositions).mockResolvedValue(pos);

    const res = await app.inject({ method: "GET", url: `/api/v1/positions/${WALLET}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ positions: pos });
  });

  it("returns 400 for an invalid public key", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/positions/not-a-key" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns 503 when the SDK throws", async () => {
    const app = buildApp();
    vi.mocked(resolvePositions).mockRejectedValue(new Error("RPC down"));
    const res = await app.inject({ method: "GET", url: `/api/v1/positions/${WALLET}` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("POST /api/v1/tx/deposit", () => {
  const validBody = { walletAddress: WALLET, vaultId: "blend-usdc-fixed", amount: "10" };

  it("returns 200 with xdr and fee from the SDK", async () => {
    const app = buildApp();
    vi.mocked(buildDepositTx).mockResolvedValue({ xdr: "TXXDR", fee: "100" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ xdr: "TXXDR", fee: "100" });
  });

  it("returns 400 when walletAddress is missing", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vaultId: "blend-usdc-fixed", amount: "10" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns 400 when amount does not match the decimal pattern", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, amount: "not-a-number" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 when the SDK throws a simulation error", async () => {
    const app = buildApp();
    vi.mocked(buildDepositTx).mockRejectedValue(new Error("Simulation failed: HostError"));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("POST /api/v1/tx/withdraw", () => {
  const validBody = { walletAddress: WALLET, vaultId: "blend-usdc-fixed", shares: "5" };

  it("returns 200 with xdr and fee from the SDK", async () => {
    const app = buildApp();
    vi.mocked(buildWithdrawTx).mockResolvedValue({ xdr: "WITHDRAWXDR", fee: "100" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/withdraw",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ xdr: "WITHDRAWXDR", fee: "100" });
  });

  it("returns 400 for a missing shares field", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/withdraw",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: WALLET, vaultId: "blend-usdc-fixed" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 when the SDK throws", async () => {
    const app = buildApp();
    vi.mocked(buildWithdrawTx).mockRejectedValue(new Error("withdraw failed"));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/withdraw",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(500);
  });
});

describe("POST /api/v1/tx/add-trustline", () => {
  it("returns 200 with xdr from the SDK", async () => {
    const app = buildApp();
    vi.mocked(buildAddTrustlineTx).mockResolvedValue({ xdr: "TRUSTLINEXDR" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/add-trustline",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: WALLET }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ xdr: "TRUSTLINEXDR" });
  });

  it("returns 400 for an invalid walletAddress", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/add-trustline",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: "bad-address" }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/tx/submit", () => {
  it("returns 200 with the submit result from the SDK", async () => {
    const app = buildApp();
    vi.mocked(submitTx).mockResolvedValue({ hash: "abc123", status: "SUCCESS", ledger: 42 });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/submit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr: "SIGNEDXDR" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hash: "abc123", status: "SUCCESS", ledger: 42 });
  });

  it("returns 400 for an empty xdr string", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/submit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr: "" }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/vaults", () => {
  it("returns 200 with vault list and recommendedVaultId", async () => {
    const app = buildApp();
    const vault = { id: "blend-usdc-fixed", apy: 0.05 };
    vi.mocked(fetchAllVaults).mockResolvedValue([vault] as never);
    vi.mocked(selectBestVault).mockReturnValue(vault as never);

    const res = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("vaults");
    expect(body).toHaveProperty("recommendedVaultId", "blend-usdc-fixed");
    expect(body).toHaveProperty("updatedAt");
  });

  it("sets recommendedVaultId to null when no best vault is found", async () => {
    const app = buildApp();
    vi.mocked(fetchAllVaults).mockResolvedValue([] as never);
    vi.mocked(selectBestVault).mockReturnValue(undefined as never);

    const res = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recommendedVaultId: null });
  });

  it("returns 500 when vault fetch fails", async () => {
    const app = buildApp();
    vi.mocked(fetchAllVaults).mockRejectedValue(new Error("fetch failed"));

    const res = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(500);
  });
});

describe("GET /api/v1/vaults/:vaultId", () => {
  it("returns 200 with the matching vault", async () => {
    const app = buildApp();
    const vault = { id: "blend-usdc-fixed", apy: 0.05 };
    vi.mocked(fetchAllVaults).mockResolvedValue([vault] as never);

    const res = await app.inject({ method: "GET", url: "/api/v1/vaults/blend-usdc-fixed" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "blend-usdc-fixed" });
  });

  it("returns 404 for an unknown vault ID", async () => {
    const app = buildApp();
    vi.mocked(fetchAllVaults).mockResolvedValue([] as never);

    const res = await app.inject({ method: "GET", url: "/api/v1/vaults/unknown" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });
});
