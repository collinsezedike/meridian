import { describe, it, expect } from "vitest";
import { SubmitRequestSchema } from "./schemas";

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
