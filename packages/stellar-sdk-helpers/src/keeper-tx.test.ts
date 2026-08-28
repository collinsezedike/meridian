import { describe, expect, it, vi } from "vitest";
import {
  assertAdapterUnchanged,
  expectString,
  isDefinitiveOnChainFailure,
  isStaleAdapterError,
  isTransientKeeperError,
  rawErrorText,
  StaleAdapterError,
  STALE_ADAPTER_MESSAGE,
  SubmissionFailedError,
  SubmissionInFlightError,
  submitKeeperOperation,
  TX_VALIDITY_WINDOW_MS,
} from "./keeper-tx";
import * as txModule from "./tx";

vi.mock("./tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tx")>();
  return {
    ...actual,
    simulateView: vi.fn(),
    waitForTransaction: vi.fn(),
    describeSendError: vi.fn().mockReturnValue("Describe send error"),
  };
});

describe("keeper-tx", () => {
  describe("constants and simple helpers", () => {
    it("exports TX_VALIDITY_WINDOW_MS", () => {
      expect(TX_VALIDITY_WINDOW_MS).toBe(300_000);
    });

    it("rawErrorText extracts message or converts to string", () => {
      expect(rawErrorText(new Error("custom error"))).toBe("custom error");
      expect(rawErrorText("plain string")).toBe("plain string");
      expect(rawErrorText(404)).toBe("404");
    });

    it("isDefinitiveOnChainFailure detects on-chain failure message", () => {
      expect(
        isDefinitiveOnChainFailure(new Error("Transaction 123 failed on-chain"))
      ).toBe(true);
      expect(isDefinitiveOnChainFailure(new Error("Timeout error"))).toBe(
        false
      );
    });

    it("isTransientKeeperError classifies errors correctly", () => {
      expect(
        isTransientKeeperError(new SubmissionFailedError("permanent"))
      ).toBe(false);
      expect(
        isTransientKeeperError(new SubmissionInFlightError("hash", "pending"))
      ).toBe(true);
      expect(isTransientKeeperError(new Error("Please try again later"))).toBe(
        true
      );
      expect(isTransientKeeperError(new Error("Request timed out"))).toBe(true);
      expect(isTransientKeeperError(new Error("Rate limit exceeded"))).toBe(
        true
      );
      expect(
        isTransientKeeperError(new Error("Service temporarily down"))
      ).toBe(true);
      expect(
        isTransientKeeperError(new Error("HTTP 429 Too Many Requests"))
      ).toBe(true);
      expect(isTransientKeeperError(new Error("Server error 500"))).toBe(true);
      expect(isTransientKeeperError(new Error("Fatal permission error"))).toBe(
        false
      );
    });

    it("expectString validates strings", () => {
      expect(expectString("valid", "method", "contract")).toBe("valid");
      expect(() => expectString(123, "method", "contract")).toThrow(
        "method() on contract did not return a string (got number)"
      );
    });

    it("StaleAdapterError and isStaleAdapterError", () => {
      const err = new StaleAdapterError("expected", "actual");
      expect(err.message).toContain(STALE_ADAPTER_MESSAGE);
      expect(isStaleAdapterError(err)).toBe(true);
      expect(isStaleAdapterError(new Error(STALE_ADAPTER_MESSAGE))).toBe(true);
      expect(isStaleAdapterError(new Error("Other error"))).toBe(false);
    });
  });

  describe("assertAdapterUnchanged", () => {
    it("passes when live adapter matches expected", async () => {
      vi.mocked(txModule.simulateView).mockResolvedValueOnce("adapter-1");
      await expect(
        assertAdapterUnchanged(
          {} as never,
          "vault-1",
          "passphrase",
          "adapter-1"
        )
      ).resolves.toBeUndefined();
    });

    it("throws StaleAdapterError when adapter mismatches", async () => {
      vi.mocked(txModule.simulateView).mockResolvedValueOnce("adapter-2");
      await expect(
        assertAdapterUnchanged(
          {} as never,
          "vault-1",
          "passphrase",
          "adapter-1"
        )
      ).rejects.toThrow(StaleAdapterError);
    });
  });

  describe("submitKeeperOperation", () => {
    const config = {
      network: { id: "testnet", passphrase: "Test Passphrase" },
      secretKey: "SDJVL65W4DVKN2G3V5477LSPTL2FPG35VSPM5Y4Y5W3HLSQO3542247A", // valid secret key for tests
      rpcTimeoutMs: 1000,
      confirmationTimeoutMs: 2000,
    };

    it("handles priorHash confirmed path", async () => {
      vi.mocked(txModule.waitForTransaction).mockResolvedValueOnce({
        ledger: 100,
      } as never);
      const onResolved = vi.fn();

      const res = await submitKeeperOperation(
        "contract",
        "method",
        [],
        config,
        {} as never,
        "priorHash123",
        { onResolved }
      );

      expect(res).toEqual({ hash: "priorHash123", ledger: 100 });
      expect(onResolved).toHaveBeenCalledWith("priorHash123");
    });

    it("handles priorHash on-chain failure path", async () => {
      vi.mocked(txModule.waitForTransaction).mockRejectedValueOnce(
        new Error("Transaction failed on-chain")
      );
      const onResolved = vi.fn();

      await expect(
        submitKeeperOperation(
          "contract",
          "method",
          [],
          config,
          {} as never,
          "priorHash123",
          { onResolved }
        )
      ).rejects.toThrow(SubmissionFailedError);

      expect(onResolved).toHaveBeenCalledWith("priorHash123");
    });

    it("handles priorHash in-flight error path", async () => {
      vi.mocked(txModule.waitForTransaction).mockRejectedValueOnce(
        new Error("Network timeout")
      );

      await expect(
        submitKeeperOperation(
          "contract",
          "method",
          [],
          config,
          {} as never,
          "priorHash123"
        )
      ).rejects.toThrow(SubmissionInFlightError);
    });
  });
});
