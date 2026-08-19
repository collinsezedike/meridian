import { describe, it, expect, vi, afterEach } from "vitest";
import {
  rpc,
  Horizon,
  Account,
  Asset,
  Contract,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  toStroops,
  resolveProtocol,
  waitForTransaction,
  simErrorMessage,
  buildAddTrustlineTx,
  simulateView,
  assertFaucetPayment,
  assertSubmittable,
} from "./tx";
import type { StellarNetwork } from "./types";
import { CONTRACT_ADDRESSES } from "@meridian/shared";

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

  it("surfaces a buried trustline diagnostic instead of the terse first line", () => {
    const raw =
      "HostError: Error(Contract, #13)\n\n" +
      "Event log (newest first):\n" +
      '   0: [Diagnostic Event] contract:CBQ..., topics:[error, Error(Contract, #13)], data:"escalating error to VM trap from failed host function call: call"\n' +
      '   1: [Diagnostic Event] contract:CBQ..., topics:[error, Error(Contract, #13)], data:["contract call failed", mint, [GAAA..., 100000000]]\n' +
      '   2: [Failed Diagnostic Event (not emitted)] contract:CBC..., topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", GAAA...]\n';
    expect(simErrorMessage(raw)).toBe("trustline entry is missing for account");
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

describe("simulateView", () => {
  afterEach(() => vi.restoreAllMocks());

  const CONTRACT_ID =
    "CBK5RI4BCA7TLSD2S5Q5TH2LUQAT55GF34OBTWPFUKWZ5O6YXSQDAWOJ";
  const PASSPHRASE = "Test SDF Network ; September 2015";

  it("simulates a call to the given contract/method/args and decodes the result", async () => {
    const server = {
      simulateTransaction: vi.fn(async () => ({
        transactionData: {},
        result: { retval: nativeToScVal(42, { type: "i128" }) },
      })),
    } as unknown as rpc.Server;

    const arg = nativeToScVal(7, { type: "u32" });
    const result = await simulateView(
      server,
      CONTRACT_ID,
      PASSPHRASE,
      "get_total_assets",
      arg
    );

    expect(result).toBe(42n);
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);

    // Verify the operation actually built targets the right contract/method/args.
    const [builtTx] = vi.mocked(server.simulateTransaction).mock.calls[0]!;
    const invocation = builtTx
      .toEnvelope()
      .v1()
      .tx()
      .operations()[0]!
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract();
    expect(invocation.contractAddress().contractId().toString("hex")).toBe(
      new Contract(CONTRACT_ID).address().toBuffer().toString("hex")
    );
    expect(invocation.functionName().toString()).toBe("get_total_assets");
    expect(invocation.args()).toEqual([arg]);
  });

  it("returns null when the simulation succeeds with no return value", async () => {
    const server = {
      simulateTransaction: vi.fn(async () => ({
        transactionData: {},
        result: undefined,
      })),
    } as unknown as rpc.Server;

    const result = await simulateView(
      server,
      CONTRACT_ID,
      PASSPHRASE,
      "no_return_method"
    );
    expect(result).toBeNull();
  });

  it("throws a sanitized message when simulation fails", async () => {
    const server = {
      simulateTransaction: vi.fn(async () => ({
        error: "HostError: Error(Contract, #1)\nEvent log ...",
      })),
    } as unknown as rpc.Server;

    await expect(
      simulateView(server, CONTRACT_ID, PASSPHRASE, "failing_method")
    ).rejects.toThrow("HostError: Error(Contract, #1)");
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
  "GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD";

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

describe("assertFaucetPayment", () => {
  const USER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  // Circle's mainnet USDC issuer: a validly-formed address that is not the
  // testnet USDC/mUSDC issuer.
  const UNKNOWN_ISSUER =
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  function buildTx(op: xdr.Operation, source = USER) {
    const account = new Account(source, "0");
    return new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build()
      .toXDR();
  }

  it("allows a payment crediting the caller in the known USDC asset", () => {
    const xdr = buildTx(
      Operation.payment({
        destination: USER,
        asset: new Asset("USDC", USDC_ISSUER_TESTNET),
        amount: "100",
      })
    );
    expect(() =>
      assertFaucetPayment(xdr, TESTNET.passphrase, "testnet", USER)
    ).not.toThrow();
  });

  it("allows a changeTrust to the known USDC or mUSDC issuer", () => {
    const xdr = buildTx(
      Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER_TESTNET) })
    );
    expect(() =>
      assertFaucetPayment(xdr, TESTNET.passphrase, "testnet", USER)
    ).not.toThrow();
  });

  it("rejects a payment to an address other than the caller", () => {
    const attacker = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
    const xdr = buildTx(
      Operation.payment({
        destination: attacker,
        asset: new Asset("USDC", USDC_ISSUER_TESTNET),
        amount: "100",
      })
    );
    expect(() =>
      assertFaucetPayment(xdr, TESTNET.passphrase, "testnet", USER)
    ).toThrow(/unexpected address/);
  });

  it("rejects a payment in an unrecognised asset", () => {
    const xdr = buildTx(
      Operation.payment({
        destination: USER,
        asset: new Asset("USDC", UNKNOWN_ISSUER),
        amount: "100",
      })
    );
    expect(() =>
      assertFaucetPayment(xdr, TESTNET.passphrase, "testnet", USER)
    ).toThrow(/unrecognised asset/);
  });

  it("rejects a payment above the amount ceiling", () => {
    const xdr = buildTx(
      Operation.payment({
        destination: USER,
        asset: new Asset("USDC", USDC_ISSUER_TESTNET),
        amount: "1000000",
      })
    );
    expect(() =>
      assertFaucetPayment(xdr, TESTNET.passphrase, "testnet", USER)
    ).toThrow(/unexpectedly large amount/);
  });

  it("rejects a changeTrust to an unrecognised issuer", () => {
    const xdr = buildTx(
      Operation.changeTrust({ asset: new Asset("USDC", UNKNOWN_ISSUER) })
    );
    expect(() =>
      assertFaucetPayment(xdr, TESTNET.passphrase, "testnet", USER)
    ).toThrow(/unrecognised issuer/);
  });

  it("rejects a disallowed operation type", () => {
    const xdr = buildTx(Operation.setOptions({ homeDomain: "evil.example" }));
    expect(() =>
      assertFaucetPayment(xdr, TESTNET.passphrase, "testnet", USER)
    ).toThrow(/disallowed operation type/);
  });
});

describe("assertSubmittable", () => {
  const network: StellarNetwork = {
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
  };

  const KNOWN_VAULT = CONTRACT_ADDRESSES.testnet.vault;
  // Circle's mainnet USDC SAC: a validly-formed contract ID that is not on the
  // testnet allowlist.
  const UNKNOWN_CONTRACT =
    "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
  const USDC_ISSUER_TESTNET =
    "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
  const MUSDC_ISSUER_TESTNET =
    "GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD";
  // Circle's mainnet USDC issuer: a validly-formed address that is not on the
  // testnet allowlist.
  const UNKNOWN_ISSUER =
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const SOURCE = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  function buildTx(
    op: ReturnType<typeof Operation.changeTrust> | ReturnType<Contract["call"]>
  ) {
    const account = new Account(SOURCE, "0");
    return new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: network.passphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
  }

  it("allows a transaction invoking a known Meridian contract", () => {
    const contract = new Contract(KNOWN_VAULT);
    const tx = buildTx(contract.call("deposit"));
    expect(() => assertSubmittable(tx, network)).not.toThrow();
  });

  it("rejects a transaction invoking an unrecognised contract", () => {
    const contract = new Contract(UNKNOWN_CONTRACT);
    const tx = buildTx(contract.call("drain"));
    expect(() => assertSubmittable(tx, network)).toThrow(
      /unrecognised contract/
    );
  });

  it("allows a changeTrust to the known USDC issuer", () => {
    const tx = buildTx(
      Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER_TESTNET) })
    );
    expect(() => assertSubmittable(tx, network)).not.toThrow();
  });

  it("allows a changeTrust to the known mUSDC issuer", () => {
    const tx = buildTx(
      Operation.changeTrust({
        asset: new Asset("MUSDC", MUSDC_ISSUER_TESTNET),
      })
    );
    expect(() => assertSubmittable(tx, network)).not.toThrow();
  });

  it("rejects a changeTrust to an unrecognised issuer", () => {
    const tx = buildTx(
      Operation.changeTrust({ asset: new Asset("USDC", UNKNOWN_ISSUER) })
    );
    expect(() => assertSubmittable(tx, network)).toThrow(/unrecognised issuer/);
  });

  it("rejects a transaction invoking the DeFindex factory contract", () => {
    // The factory deploys other contracts; allowlisting it would let
    // /tx/submit relay arbitrary invocations against it, no real deposit or
    // withdraw flow ever calls it (see #482).
    const contract = new Contract(CONTRACT_ADDRESSES.testnet.defindex.factory);
    const tx = buildTx(contract.call("deploy"));
    expect(() => assertSubmittable(tx, network)).toThrow(
      /unrecognised contract/
    );
  });

  it("rejects a disallowed operation type", () => {
    const tx = buildTx(
      Operation.payment({
        destination: SOURCE,
        asset: Asset.native(),
        amount: "1",
      })
    );
    expect(() => assertSubmittable(tx, network)).toThrow(
      /disallowed operation type/
    );
  });
});
