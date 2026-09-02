import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  buildDepositTx: vi.fn(async () => ({ xdr: "DEPOSIT_XDR", fee: "100" })),
  buildWithdrawTx: vi.fn(async () => ({ xdr: "WITHDRAW_XDR", fee: "100" })),
  buildAddTrustlineTx: vi.fn(async () => ({ xdr: "TRUST_XDR" })),
  submitTx: vi.fn(async () => ({ hash: "HASH" })),
}));

import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleAddTrustlineRequest,
  handleSubmitRequest,
} from "./tx";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
} from "@meridian/stellar-sdk-helpers";

const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => vi.clearAllMocks());

describe("handleDepositRequest", () => {
  it("returns 400 listing the missing fields", async () => {
    const result = await handleDepositRequest({ walletAddress: PUBKEY });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error:
        "vaultId: Invalid input: expected string, received undefined; amount: Invalid input: expected string, received undefined",
    });
  });

  it("builds the deposit transaction and returns the XDR", async () => {
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ xdr: "DEPOSIT_XDR", fee: "100" });
    expect(result.error).toBeUndefined();
    expect(buildDepositTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "10",
      expect.anything(),
      "0"
    );
  });

  it("passes min_shares_out when provided in deposit request", async () => {
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      min_shares_out: "9.5",
    });
    expect(result.status).toBe(200);
    expect(buildDepositTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "10",
      expect.anything(),
      "9.5"
    );
  });

  it("surfaces builder errors as 500 and returns the raw error for logging", async () => {
    const err = new Error("USDC trustline missing");
    vi.mocked(buildDepositTx).mockRejectedValueOnce(err);
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
    });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "USDC trustline missing" });
    expect(result.error).toBe(err);
  });
});

describe("handleWithdrawRequest", () => {
  it("returns 400 when shares is missing", async () => {
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "v",
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: "shares: Invalid input: expected string, received undefined",
    });
  });

  it("builds the withdraw transaction, defaulting min_usdc_out to 0", async () => {
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
    });
    expect(result.body).toEqual({ xdr: "WITHDRAW_XDR", fee: "100" });
    expect(buildWithdrawTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "5",
      expect.anything(),
      "0"
    );
  });

  it("forwards an explicit min_usdc_out to buildWithdrawTx", async () => {
    await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
      min_usdc_out: "4.9",
    });
    expect(buildWithdrawTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "5",
      expect.anything(),
      "4.9"
    );
  });

  it("surfaces builder errors as 500 and returns the raw error for logging", async () => {
    const err = new Error("withdraw failed");
    vi.mocked(buildWithdrawTx).mockRejectedValueOnce(err);
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
    });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "withdraw failed" });
    expect(result.error).toBe(err);
  });
});

describe("handleAddTrustlineRequest", () => {
  it("returns 400 without a wallet address", async () => {
    const result = await handleAddTrustlineRequest({});
    expect(result.status).toBe(400);
  });

  it("returns the trustline XDR", async () => {
    const result = await handleAddTrustlineRequest({ walletAddress: PUBKEY });
    expect(result.body).toEqual({ xdr: "TRUST_XDR" });
  });

  it("surfaces builder errors as 500 and returns the raw error for logging", async () => {
    const err = new Error("trustline build failed");
    vi.mocked(buildAddTrustlineTx).mockRejectedValueOnce(err);
    const result = await handleAddTrustlineRequest({ walletAddress: PUBKEY });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "trustline build failed" });
    expect(result.error).toBe(err);
  });
});

describe("handleSubmitRequest", () => {
  it("returns 400 without an xdr", async () => {
    const result = await handleSubmitRequest({});
    expect(result.status).toBe(400);
  });

  it("submits and returns the tx hash", async () => {
    const result = await handleSubmitRequest({ xdr: "SIGNED" });
    expect(result.body).toEqual({ hash: "HASH" });
  });

  it("surfaces submit errors as 500 and returns the raw error for logging", async () => {
    const err = new Error("submit failed");
    vi.mocked(submitTx).mockRejectedValueOnce(err);
    const result = await handleSubmitRequest({ xdr: "SIGNED" });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "submit failed" });
    expect(result.error).toBe(err);
  });
});
