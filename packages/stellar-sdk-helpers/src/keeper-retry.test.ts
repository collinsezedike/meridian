import { describe, expect, it, vi } from "vitest";
import {
  consoleLogger,
  errorMessage,
  KeeperRetryError,
  parseNonNegativeInt,
  parsePositiveInt,
  redactedErrorMessage,
  retryOutcome,
  sleep,
  withKeeperRetry,
} from "./keeper-retry";

describe("keeper-retry", () => {
  describe("consoleLogger", () => {
    it("logs info, warn, and error", () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      consoleLogger.info("info msg", { a: 1 });
      consoleLogger.warn("warn msg");
      consoleLogger.error("error msg", { b: 2 });

      expect(infoSpy).toHaveBeenCalledWith("info msg", { a: 1 });
      expect(warnSpy).toHaveBeenCalledWith("warn msg", {});
      expect(errorSpy).toHaveBeenCalledWith("error msg", { b: 2 });

      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("sleep", () => {
    it("resolves after timeout", async () => {
      vi.useFakeTimers();
      const promise = sleep(100);
      vi.advanceTimersByTime(100);
      await expect(promise).resolves.toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe("errorMessage", () => {
    it("formats error messages correctly", () => {
      expect(errorMessage(new Error("First line\nSecond line"))).toBe(
        "First line"
      );
      expect(errorMessage(new Error(""))).toBe("");
      expect(errorMessage("string error")).toBe("string error");
      expect(errorMessage(123)).toBe("123");
    });
  });

  describe("redactedErrorMessage", () => {
    it("redacts secret/sensitive content", () => {
      expect(redactedErrorMessage(new Error("RPC failed"))).toBeDefined();
    });
  });

  describe("parsePositiveInt", () => {
    it("parses valid positive integers and uses fallbacks", () => {
      expect(parsePositiveInt(undefined, 10, "test")).toBe(10);
      expect(parsePositiveInt("", 10, "test")).toBe(10);
      expect(parsePositiveInt("   ", 10, "test")).toBe(10);
      expect(parsePositiveInt("5", 10, "test")).toBe(5);
    });

    it("throws on non-integer or non-positive values", () => {
      expect(() => parsePositiveInt("0", 10, "test")).toThrow(
        "test must be a positive integer"
      );
      expect(() => parsePositiveInt("-1", 10, "test")).toThrow(
        "test must be a positive integer"
      );
      expect(() => parsePositiveInt("1.5", 10, "test")).toThrow(
        "test must be a positive integer"
      );
      expect(() => parsePositiveInt("abc", 10, "test")).toThrow(
        "test must be a positive integer"
      );
    });
  });

  describe("parseNonNegativeInt", () => {
    it("parses valid non-negative integers and uses fallbacks", () => {
      expect(parseNonNegativeInt(undefined, 0, "test")).toBe(0);
      expect(parseNonNegativeInt("0", 10, "test")).toBe(0);
      expect(parseNonNegativeInt("5", 10, "test")).toBe(5);
    });

    it("throws on non-integer or negative values", () => {
      expect(() => parseNonNegativeInt("-1", 10, "test")).toThrow(
        "test must be a non-negative integer"
      );
      expect(() => parseNonNegativeInt("2.3", 10, "test")).toThrow(
        "test must be a non-negative integer"
      );
    });
  });

  describe("KeeperRetryError", () => {
    it("creates an error with attempt count and transient status", () => {
      const err = new KeeperRetryError(new Error("boom"), 3, true);
      expect(err.name).toBe("KeeperRetryError");
      expect(err.message).toBe("boom");
      expect(err.attempts).toBe(3);
      expect(err.transient).toBe(true);
    });
  });

  describe("retryOutcome", () => {
    it("unwraps KeeperRetryError details", () => {
      const retryErr = new KeeperRetryError("fail", 2, true);
      expect(retryOutcome(retryErr, () => false)).toEqual({
        attempts: 2,
        transient: true,
      });
    });

    it("uses isTransient predicate for non-KeeperRetryError", () => {
      const genericErr = new Error("bad state");
      expect(retryOutcome(genericErr, (e) => e === genericErr)).toEqual({
        attempts: 1,
        transient: true,
      });
    });
  });

  describe("withKeeperRetry", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    it("returns value on first success", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      const res = await withKeeperRetry(
        fn,
        { maxAttempts: 3, baseDelayMs: 10 },
        mockLogger,
        {},
        mockSleep,
        () => true,
        "TEST"
      );
      expect(res).toEqual({ value: "ok", attempts: 1 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on transient failure and succeeds", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce("success");

      const res = await withKeeperRetry(
        fn,
        { maxAttempts: 3, baseDelayMs: 10 },
        mockLogger,
        {},
        mockSleep,
        () => true,
        "TEST"
      );

      expect(res).toEqual({ value: "success", attempts: 2 });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "[TEST] transient failure; retrying",
        expect.objectContaining({ attempt: 1, nextAttempt: 2 })
      );
    });

    it("stops immediately on non-transient error", async () => {
      const nonTransientErr = new Error("fatal");
      const fn = vi.fn().mockRejectedValue(nonTransientErr);

      await expect(
        withKeeperRetry(
          fn,
          { maxAttempts: 3, baseDelayMs: 10 },
          mockLogger,
          {},
          mockSleep,
          () => false,
          "TEST"
        )
      ).rejects.toThrow(KeeperRetryError);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("stops when approaching deadline", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("transient"));
      const deadlineAt = Date.now() + 15; // less than delay calculated for retry

      await expect(
        withKeeperRetry(
          fn,
          { maxAttempts: 3, baseDelayMs: 20, deadlineAt },
          mockLogger,
          {},
          mockSleep,
          () => true,
          "TEST"
        )
      ).rejects.toThrow(KeeperRetryError);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "[TEST] stopping retries; run deadline approaching",
        expect.objectContaining({ attempt: 1 })
      );
    });
  });
});
