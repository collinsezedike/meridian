import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, sanitizeTxError } from "./utils";

describe("sanitizeTxError", () => {
  it("returns the fallback for non-Error values", () => {
    expect(sanitizeTxError("string error", "fallback")).toBe("fallback");
    expect(sanitizeTxError(42, "fallback")).toBe("fallback");
    expect(sanitizeTxError(null, "fallback")).toBe("fallback");
    expect(sanitizeTxError(undefined, "fallback")).toBe("fallback");
  });

  it("returns the first line of a clean multi-line error message", () => {
    const err = new Error("Transaction simulation failed\n  at contract: ...\n  context: ...");
    expect(sanitizeTxError(err, "fallback")).toBe("Transaction simulation failed");
  });

  it("returns the fallback when the first line contains an RPC URL", () => {
    const err = new Error("fetch failed: https://soroban-testnet.stellar.org\nmore detail");
    expect(sanitizeTxError(err, "fallback")).toBe("fallback");
  });

  it("returns the fallback when the first line contains a contract C-address", () => {
    const err = new Error("CCQNJ4SJM5NKRBJK3G4YATDUZPTLWVKWKJTPBFHIFVQMQJDQVLSEHWA: not found");
    expect(sanitizeTxError(err, "fallback")).toBe("fallback");
  });

  it("returns the fallback for an empty or whitespace-only message", () => {
    expect(sanitizeTxError(new Error(""), "fallback")).toBe("fallback");
    expect(sanitizeTxError(new Error("  \n  "), "fallback")).toBe("fallback");
  });

  it("passes through safe user-facing error messages unchanged", () => {
    const err = new Error("All required trustlines already exist");
    expect(sanitizeTxError(err, "fallback")).toBe("All required trustlines already exist");
  });
});

describe("withRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves immediately when fn succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and resolves when fn fails then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, 3, 0);
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws last error after exhausting all attempts", async () => {
    const err = new Error("persistent");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, 3, 0);
    const assertion = expect(promise).rejects.toThrow("persistent");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects maxAttempts=1 by not retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    const promise = withRetry(fn, 1, 0);
    const assertion = expect(promise).rejects.toThrow("fail");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops after first failure when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("timeout"));
    const shouldRetry = vi.fn().mockReturnValue(false);
    const promise = withRetry(fn, 3, 0, shouldRetry);
    const assertion = expect(promise).rejects.toThrow("timeout");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors but not excluded error types", async () => {
    class TimeoutError extends Error {}
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new TimeoutError("deadline"))
      .mockResolvedValue("ok");
    const promise = withRetry(fn, 3, 0, (err) => !(err instanceof TimeoutError));
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
