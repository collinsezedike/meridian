import { describe, expect, it } from "vitest";

import {
  STALE_ADAPTER_MESSAGE,
  StaleAdapterError,
  SubmissionFailedError,
  SubmissionInFlightError,
  expectString,
  isDefinitiveOnChainFailure,
  isStaleAdapterError,
  isTransientKeeperError,
  rawErrorText,
} from "./keeper-tx";

const HASH = "a".repeat(64);

describe("rawErrorText", () => {
  it("keeps every line of an Error message", () => {
    // The whole point of this over errorMessage(): a status code on a later
    // line still has to be visible to the classifiers below.
    expect(rawErrorText(new Error("wrapped fetch failure\nstatus 503"))).toBe(
      "wrapped fetch failure\nstatus 503"
    );
  });

  it("stringifies a non-Error throw", () => {
    expect(rawErrorText("plain string")).toBe("plain string");
    expect(rawErrorText(undefined)).toBe("undefined");
  });
});

describe("isDefinitiveOnChainFailure", () => {
  it("matches waitForTransaction's confirmed-failure message", () => {
    expect(
      isDefinitiveOnChainFailure(
        new Error(`Transaction ${HASH} failed on-chain`)
      )
    ).toBe(true);
  });

  it("does not match its timeout message, whose outcome is still unknown", () => {
    expect(
      isDefinitiveOnChainFailure(
        new Error(`Timed out waiting for transaction ${HASH} to confirm`)
      )
    ).toBe(false);
  });
});

describe("isTransientKeeperError", () => {
  it("is false for a SubmissionFailedError regardless of its message text", () => {
    // Confirmed failed on-chain: resubmitting has no reason to succeed, even
    // though the wrapped message happens to contain a transient keyword.
    expect(
      isTransientKeeperError(
        new SubmissionFailedError(new Error("timed out; rate limit 503"))
      )
    ).toBe(false);
  });

  it("is true for a SubmissionInFlightError, whose real outcome is unknown", () => {
    expect(
      isTransientKeeperError(
        new SubmissionInFlightError(HASH, new Error("socket hang up"))
      )
    ).toBe(true);
  });

  it("matches transient keywords case-insensitively", () => {
    expect(isTransientKeeperError(new Error("Please try again"))).toBe(true);
    expect(isTransientKeeperError(new Error("Request TIMEOUT"))).toBe(true);
    expect(isTransientKeeperError(new Error("Timed Out waiting"))).toBe(true);
    expect(isTransientKeeperError(new Error("Rate Limit exceeded"))).toBe(true);
    expect(isTransientKeeperError(new Error("temporarily unavailable"))).toBe(
      true
    );
  });

  it("matches retryable HTTP status codes on word boundaries", () => {
    for (const code of [429, 500, 502, 503, 504]) {
      expect(isTransientKeeperError(new Error(`HTTP ${code}`))).toBe(true);
    }
  });

  it("ignores those digits inside a longer number", () => {
    // An amount or ledger number that merely contains 503 is not a status
    // code, and misreading it would retry a permanent failure forever.
    expect(isTransientKeeperError(new Error("ledger 15034 rejected"))).toBe(
      false
    );
    expect(isTransientKeeperError(new Error("amount 4290000 too low"))).toBe(
      false
    );
  });

  it("is false for an unrelated permanent error", () => {
    expect(isTransientKeeperError(new Error("Simulation failed: auth"))).toBe(
      false
    );
    expect(isTransientKeeperError("not an error at all")).toBe(false);
  });
});

describe("expectString", () => {
  it("returns a string value unchanged", () => {
    expect(expectString("CVAULT", "get_adapter", "CCONTRACT")).toBe("CVAULT");
  });

  it("throws a message naming the method, contract, and actual type", () => {
    expect(() => expectString(null, "get_adapter", "CCONTRACT")).toThrow(
      "get_adapter() on CCONTRACT did not return a string (got object)"
    );
    expect(() => expectString(42, "get_adapter", "CCONTRACT")).toThrow(
      "(got number)"
    );
    expect(() => expectString(undefined, "get_adapter", "CCONTRACT")).toThrow(
      "(got undefined)"
    );
  });
});

describe("isStaleAdapterError", () => {
  it("detects a StaleAdapterError by message, not by instanceof", () => {
    // withKeeperRetry rewraps errors and loses the original type, so the
    // guard has to survive being carried across as plain message text.
    const err = new StaleAdapterError("CEXPECTED", "CACTUAL");
    expect(isStaleAdapterError(err)).toBe(true);
    expect(isStaleAdapterError(new Error(err.message))).toBe(true);
    expect(err.message).toContain(STALE_ADAPTER_MESSAGE);
    expect(err.message).toContain("CEXPECTED");
    expect(err.message).toContain("CACTUAL");
  });

  it("is false for any other error", () => {
    expect(isStaleAdapterError(new Error("Simulation failed"))).toBe(false);
  });
});
