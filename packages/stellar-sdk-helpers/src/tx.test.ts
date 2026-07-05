import { describe, it, expect, vi, afterEach } from "vitest";
import { rpc, Horizon } from "@stellar/stellar-sdk";
import {
  toStroops,
  resolveProtocol,
  waitForTransaction,
  simErrorMessage,
  buildAddTrustlineTx,
  simulateView,
} from "./tx";
import type { StellarNetwork } from "./types";

const { SUCCESS, FAILED, NOT_FOUND } = rpc.Api.GetTransactionStatus;

// A getTransaction stub that replays a fixed sequence of statuses, repeating the
// last one once exhausted, and counts how many times it was polled.
function fakeReader(statuses: rpc.Api.GetTransactionStatus[]) {
  let i = 0;
  const reader = {
    calls: 0,
    async getTransaction() {
      reader.calls += 1;
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return { status, ledger: 42 } as rpc.Api.GetTransactionResponse;
    },
  };
  return reader;
}

// Sleep is a no-op in tests; `now` steps forward a fixed amount on every call so
// the timeout deadline is reached deterministically without real timers.
const noopSleep = async () => {};
function steppingClock(stepMs: number) {
  let t = 0;
  return () => (t += stepMs);
}

describe("simErrorMessage", () => {
  it("returns just the first line of a multi-line diagnostic", () => {
    const raw = "HostError: Error(Contract, #1)\n  at [0]: ...\n  at [1]: ...";
    expect(simErrorMessage(raw)).toBe("HostError: Error(Contract, #1)");
  });

  it("trims surrounding whitespace", () => {
    expect(simErrorMessage("  Error(WasmVm, InvalidAction)  ")).toBe(
      "Error(WasmVm, InvalidAction)"
    );
  });

  it("returns a fallback for empty or whitespace-only errors", () => {
    expect(simErrorMessage("")).toBe("Simulation failed (no detail)");
    expect(simErrorMessage("\n\n")).toBe("Simulation failed (no detail)");
  });
});

describe("simulateView RPC timeout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("registers a 10 s deadline for each Soroban RPC call", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // The server mock resolves immediately so we don't need to wait for the
    // timeout — we only need to verify the deadline was registered.
    const server = {
      simulateTransaction: vi.fn(
        async () =>
          ({
            id: "1",
            events: [],
            minResourceFee: "100",
            results: [],
            transactionData: new (
              await import("@stellar/stellar-sdk")
            ).rpc.Server("https://soroban-testnet.stellar.org"),
          }) as unknown as Awaited<
            ReturnType<rpc.Server["simulateTransaction"]>
          >
      ),
    } as unknown as rpc.Server;

    try {
      await simulateView(
        server,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        "Test SDF Network ; September 2015",
        "method"
      );
    } catch {
      // The simulation result is not valid — only setTimeout registration matters.
    }

    const timeouts = setTimeoutSpy.mock.calls.map(([, ms]) => ms);
    expect(timeouts).toContain(10_000);
  });
});

describe("toStroops", () => {
  it("converts whole USDC amounts to 7-decimal stroops", () => {
    expect(toStroops("1")).toBe(10_000_000n);
    expect(toStroops("100")).toBe(1_000_000_000n);
    expect(toStroops("0")).toBe(0n);
  });

  it("converts fractional amounts", () => {
    expect(toStroops("1.5")).toBe(15_000_000n);
    expect(toStroops("123.45")).toBe(1_234_500_000n);
  });

  it("handles the smallest unit (1 stroop) and zero-padded fractions", () => {
    expect(toStroops("0.0000001")).toBe(1n);
    expect(toStroops("0.05")).toBe(500_000n);
  });

  it("truncates fractional precision beyond 7 decimals rather than rounding", () => {
    expect(toStroops("1.23456789")).toBe(12_345_678n);
  });

  it("treats a missing fractional part as zero", () => {
    expect(toStroops("42")).toBe(420_000_000n);
  });
});

describe("resolveProtocol", () => {
  it("maps blend vault ids to Blend", () => {
    expect(resolveProtocol("blend-usdc-fixed")).toBe("Blend");
    expect(resolveProtocol("blend-eurc-variable")).toBe("Blend");
  });

  it("maps defindex vault ids to DeFindex", () => {
    expect(resolveProtocol("defindex-usdc")).toBe("DeFindex");
  });

  it("throws for vault ids with no protocol mapping", () => {
    expect(() => resolveProtocol("ondo-usdy")).toThrow(/No protocol mapping/);
    expect(() => resolveProtocol("")).toThrow(/No protocol mapping/);
  });
});

const TESTNET: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const USDC_ISSUER_TESTNET =
  "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
const MUSDC_ISSUER_TESTNET =
  "GAZOB5KAE27U7QMGCJLA74TKGECONNND73GL2GIMYBXYNBVG4U5IHBX7";

function makeBalance(
  code: string,
  issuer: string
): Horizon.HorizonApi.BalanceLine {
  return {
    asset_type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    asset_code: code,
    asset_issuer: issuer,
    balance: "0.0000000",
    limit: "922337203685.4775807",
    buying_liabilities: "0.0000000",
    selling_liabilities: "0.0000000",
    is_authorized: true,
    is_authorized_to_maintain_liabilities: true,
    last_modified_ledger: 1,
    sponsor: undefined,
  } as unknown as Horizon.HorizonApi.BalanceLine;
}

describe("buildAddTrustlineTx", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws when all required trustlines already exist", async () => {
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue({
      balances: [
        makeBalance("USDC", USDC_ISSUER_TESTNET),
        makeBalance("MUSDC", MUSDC_ISSUER_TESTNET),
      ],
    } as unknown as Awaited<ReturnType<Horizon.Server["loadAccount"]>>);

    await expect(
      buildAddTrustlineTx(
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        TESTNET
      )
    ).rejects.toThrow("All required trustlines already exist");
  });
});

describe("waitForTransaction", () => {
  it("resolves once the transaction reaches SUCCESS", async () => {
    const reader = fakeReader([NOT_FOUND, NOT_FOUND, SUCCESS]);
    const res = await waitForTransaction(reader, "TXHASH", {
      sleep: noopSleep,
    });
    expect(res.status).toBe(SUCCESS);
    expect(res.ledger).toBe(42);
    expect(reader.calls).toBe(3);
  });

  it("polls only until the first final status, not beyond", async () => {
    const reader = fakeReader([SUCCESS]);
    await waitForTransaction(reader, "TXHASH", { sleep: noopSleep });
    expect(reader.calls).toBe(1);
  });

  it("throws when the transaction fails on-chain", async () => {
    const reader = fakeReader([NOT_FOUND, FAILED]);
    await expect(
      waitForTransaction(reader, "TXHASH", { sleep: noopSleep })
    ).rejects.toThrow(/failed on-chain/);
  });

  it("times out while the transaction stays NOT_FOUND", async () => {
    const reader = fakeReader([NOT_FOUND]);
    await expect(
      waitForTransaction(reader, "TXHASH", {
        sleep: noopSleep,
        now: steppingClock(5_000),
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/Timed out/);
  });
});
