import { describe, it, expect } from "vitest";
import {
  DepositRequestSchema,
  WithdrawRequestSchema,
  TrustlineRequestSchema,
  SubmitRequestSchema,
  formatZodError,
} from "./schemas";

const VALID_ADDRESS =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("DepositRequestSchema", () => {
  it("accepts a valid deposit request", () => {
    const result = DepositRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      amount: "100.5",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed wallet address", () => {
    const result = DepositRequestSchema.safeParse({
      walletAddress: "not-an-address",
      vaultId: "meridian-usdc",
      amount: "100",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an amount with more than 7 decimal places", () => {
    const result = DepositRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      amount: "100.12345678",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid deposit request with min_shares_out", () => {
    const result = DepositRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      amount: "100.5",
      min_shares_out: "99.0",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_shares_out).toBe("99.0");
    }
  });

  it("defaults min_shares_out to 0 when omitted", () => {
    const result = DepositRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      amount: "100.5",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_shares_out).toBe("0");
    }
  });

  it("rejects min_shares_out with more than 7 decimal places", () => {
    const result = DepositRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      amount: "100.5",
      min_shares_out: "99.12345678",
    });
    expect(result.success).toBe(false);
  });
});

describe("WithdrawRequestSchema", () => {
  it("accepts a valid withdraw request", () => {
    const result = WithdrawRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      shares: "50",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_usdc_out).toBe("0");
    }
  });

  it("accepts a valid withdraw request with min_usdc_out", () => {
    const result = WithdrawRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      shares: "50",
      min_usdc_out: "49.5",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_usdc_out).toBe("49.5");
    }
  });

  it("rejects a non-numeric shares value", () => {
    const result = WithdrawRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      shares: "all of it",
    });
    expect(result.success).toBe(false);
  });

  it("rejects min_usdc_out with more than 7 decimal places", () => {
    const result = WithdrawRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
      vaultId: "meridian-usdc",
      shares: "50",
      min_usdc_out: "49.12345678",
    });
    expect(result.success).toBe(false);
  });
});

describe("TrustlineRequestSchema", () => {
  it("accepts a valid wallet address", () => {
    const result = TrustlineRequestSchema.safeParse({
      walletAddress: VALID_ADDRESS,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed wallet address", () => {
    const result = TrustlineRequestSchema.safeParse({
      walletAddress: "not-an-address",
    });
    expect(result.success).toBe(false);
  });
});

describe("SubmitRequestSchema", () => {
  it("accepts a realistically-sized signed transaction envelope", () => {
    const result = SubmitRequestSchema.safeParse({ xdr: "A".repeat(2_000) });
    expect(result.success).toBe(true);
  });

  it("rejects an oversized xdr payload", () => {
    const result = SubmitRequestSchema.safeParse({ xdr: "A".repeat(10_001) });
    expect(result.success).toBe(false);
  });

  it("rejects an empty xdr string", () => {
    const result = SubmitRequestSchema.safeParse({ xdr: "" });
    expect(result.success).toBe(false);
  });
});

describe("formatZodError", () => {
  it("joins multiple field errors into a single semicolon-separated string", () => {
    const result = DepositRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(formatZodError(result.error)).toBe(
      "walletAddress: Invalid input: expected string, received undefined; vaultId: Invalid input: expected string, received undefined; amount: Invalid input: expected string, received undefined"
    );
  });
});
