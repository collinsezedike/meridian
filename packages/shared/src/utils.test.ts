import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  withRaceTimeout,
  sanitizeTxError,
  fromStroops,
  formatUsdAmount,
  parseUsdAmount,
  shortenAddress,
} from "./utils";

describe("sanitizeTxError", () => {
  it("returns the fallback for non-Error values", () => {
    expect(sanitizeTxError("string error", "fallback")).toBe("fallback");
    expect(sanitizeTxError(42, "fallback")).toBe("fallback");
    expect(sanitizeTxError(null, "fallback")).toBe("fallback");
    expect(sanitizeTxError(undefined, "fallback")).toBe("fallback");
  });

  it("returns the first line of a clean multi-line error message", () => {
    const err = new Error(
      "Transaction simulation failed\n  at contract: ...\n  context: ..."
    );
    expect(sanitizeTxError(err, "fallback")).toBe(
      "Transaction simulation failed"
    );
  });

  it("returns the fallback when the first line contains an RPC URL", () => {
    const err = new Error(
      "fetch failed: https://soroban-testnet.stellar.org\nmore detail"
    );
    expect(sanitizeTxError(err, "fallback")).toBe("fallback");
  });

  it("returns the fallback when the first line contains a contract C-address", () => {
    const err = new Error(
      "CCQNJ4SJM5NKRBJK3G4YATDUZPTLWVKWKJTPBFHIFVQMQJDQVLSEHWA: not found"
    );
    expect(sanitizeTxError(err, "fallback")).toBe("fallback");
  });

  it("returns the fallback for an empty or whitespace-only message", () => {
    expect(sanitizeTxError(new Error(""), "fallback")).toBe("fallback");
    expect(sanitizeTxError(new Error("  \n  "), "fallback")).toBe("fallback");
  });

  it("passes through safe user-facing error messages unchanged", () => {
    const err = new Error("All required trustlines already exist");
    expect(sanitizeTxError(err, "fallback")).toBe(
      "All required trustlines already exist"
    );
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
    const promise = withRetry(
      fn,
      3,
      0,
      (err) => !(err instanceof TimeoutError)
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes the zero-indexed attempt number to fn and shouldRetry", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    const shouldRetry = vi.fn().mockReturnValue(true);

    const promise = withRetry(fn, 3, 0, shouldRetry);
    await vi.runAllTimersAsync();
    await promise;

    expect(fn).toHaveBeenNthCalledWith(1, 0);
    expect(fn).toHaveBeenNthCalledWith(2, 1);
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 0);
  });

  it("calls onRetry with the attempt, delay, and error before sleeping", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    const promise = withRetry(fn, 3, 10, undefined, { onRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledWith(0, 10, expect.any(Error));
  });

  it("uses the injected sleepFn instead of real timers", async () => {
    vi.useRealTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(fn, 3, 500, undefined, { sleepFn });

    expect(result).toBe("ok");
    expect(sleepFn).toHaveBeenCalledWith(500);
    vi.useFakeTimers();
  });
});

describe("withRaceTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves with fn's value when fn completes before the timeout", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const result = await withRaceTimeout(fn, 1_000, "test");
    expect(result).toBe("result");
  });

  it("rejects with a timeout error when fn does not complete in time", async () => {
    const fn = vi.fn().mockImplementation(() => new Promise(() => {}));
    const promise = withRaceTimeout(fn, 500, "test op");
    const assertion = expect(promise).rejects.toThrow(
      "test op timed out after 500ms"
    );
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("clears the timeout handle when fn resolves so no lingering timer fires", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const fn = vi.fn().mockResolvedValue("ok");
    await withRaceTimeout(fn, 1_000, "test");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("clears the timeout handle when fn rejects", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withRaceTimeout(fn, 1_000, "test")).rejects.toThrow("boom");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
describe("fromStroops", () => {
  it("converts exact whole XLM", () => {
    expect(fromStroops(10_000_000n)).toBe("1");
  });

  it("converts fractional XLM", () => {
    expect(fromStroops(15_500_000n)).toBe("1.55");
  });

  it("handles zero", () => {
    expect(fromStroops(0n)).toBe("0");
  });

  it("handles negative non-exact value", () => {
    expect(fromStroops(-15_500_000n)).toBe("-1.55");
  });

  it("handles negative exact value", () => {
    expect(fromStroops(-10_000_000n)).toBe("-1");
  });

  it("preserves precision at Number.MAX_SAFE_INTEGER boundary", () => {
    expect(fromStroops(9_007_199_254_740_991n)).toBe("900719925.4740991");
  });
});

describe("formatUsdAmount", () => {
  it("formats zero", () => {
    expect(formatUsdAmount(0)).toBe("$0.00");
  });

  it("formats a typical value", () => {
    expect(formatUsdAmount(1234.5)).toBe("$1,234.50");
  });

  it("formats a large value", () => {
    expect(formatUsdAmount(1_000_000)).toBe("$1,000,000.00");
  });

  it("throws for NaN", () => {
    expect(() => formatUsdAmount(NaN)).toThrow(RangeError);
  });

  it("throws for Infinity", () => {
    expect(() => formatUsdAmount(Infinity)).toThrow(RangeError);
  });
});

describe("parseUsdAmount", () => {
  it("parses a USD string back to a number", () => {
    expect(parseUsdAmount("$1,234.50")).toBe(1234.5);
  });

  it("round-trips with formatUsdAmount", () => {
    expect(parseUsdAmount(formatUsdAmount(1234.5))).toBe(1234.5);
  });

  it("returns null for empty string", () => {
    expect(parseUsdAmount("")).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    expect(parseUsdAmount("abc")).toBeNull();
  });

  it("returns null for malformed multi-dot string", () => {
    expect(parseUsdAmount("1.2.3")).toBeNull();
  });
});
describe("shortenAddress", () => {
  it("shortens a standard G-address to 4+4 chars by default", () => {
    expect(
      shortenAddress(
        "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      )
    ).toBe("GABC...WXYZ");
  });

  it("respects a custom chars argument", () => {
    expect(
      shortenAddress(
        "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        6
      )
    ).toBe("GABCDE...UVWXYZ");
  });

  it("returns address unchanged when too short to truncate", () => {
    expect(shortenAddress("GABC")).toBe("GABC");
  });
});
