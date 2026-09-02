import { describe, it, expect, vi, beforeEach } from "vitest";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

vi.mock("./tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tx")>();
  return {
    ...actual,
    prepareSorobanTx: vi.fn(),
    simulateView: vi.fn(),
  };
});

import {
  buildCoordinatorDepositTx,
  buildCoordinatorWithdrawTx,
  fetchCoordinatorPosition,
  fetchVaultAdmin,
  fetchCoordinatorState,
} from "./coordinator";
import { prepareSorobanTx, simulateView } from "./tx";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const CONTRACT_ID = "CBK5RI4BCA7TLSD2S5Q5TH2LUQAT55GF34OBTWPFUKWZ5O6YXSQDAWOJ";
const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareSorobanTx).mockResolvedValue({
    xdr: "UNSIGNED_XDR",
    fee: "150",
  });
});

describe("buildCoordinatorDepositTx", () => {
  it("calls the vault's deposit(caller, amount, min_shares_out) with default minSharesOut=0", async () => {
    const result = await buildCoordinatorDepositTx(
      { contractId: CONTRACT_ID, network },
      WALLET,
      100_000_000n
    );

    expect(result).toEqual({ xdr: "UNSIGNED_XDR", fee: "150" });
    expect(prepareSorobanTx).toHaveBeenCalledTimes(1);
    const [passedNetwork, passedCaller, op] =
      vi.mocked(prepareSorobanTx).mock.calls[0]!;
    expect(passedNetwork).toBe(network);
    expect(passedCaller).toBe(WALLET);

    // The built operation should be an InvokeHostFunction calling "deposit"
    // with the caller's address, the i128 amount, and i128 min_shares_out (0n by default).
    const invocation = op.body().invokeHostFunctionOp().hostFunction();
    const args = invocation.invokeContract().args();
    expect(args).toHaveLength(3);
    expect(Address.fromScVal(args[0]!).toString()).toBe(WALLET);
    expect(args[1]).toEqual(nativeToScVal(100_000_000n, { type: "i128" }));
    expect(args[2]).toEqual(nativeToScVal(0n, { type: "i128" }));
  });

  it("calls deposit with caller-supplied minSharesOut", async () => {
    await buildCoordinatorDepositTx(
      { contractId: CONTRACT_ID, network },
      WALLET,
      100_000_000n,
      95_000_000n
    );

    const [, , op] = vi.mocked(prepareSorobanTx).mock.calls[0]!;
    const invocation = op.body().invokeHostFunctionOp().hostFunction();
    const args = invocation.invokeContract().args();
    expect(args).toHaveLength(3);
    expect(args[2]).toEqual(nativeToScVal(95_000_000n, { type: "i128" }));
  });

  it("throws without calling prepareSorobanTx for a non-positive amount", async () => {
    await expect(
      buildCoordinatorDepositTx(
        { contractId: CONTRACT_ID, network },
        WALLET,
        0n
      )
    ).rejects.toThrow(/amount must be positive/);
    await expect(
      buildCoordinatorDepositTx(
        { contractId: CONTRACT_ID, network },
        WALLET,
        -1n
      )
    ).rejects.toThrow(/amount must be positive/);
    expect(prepareSorobanTx).not.toHaveBeenCalled();
  });

  it("throws without calling prepareSorobanTx for a negative minSharesOut", async () => {
    await expect(
      buildCoordinatorDepositTx(
        { contractId: CONTRACT_ID, network },
        WALLET,
        100_000_000n,
        -1n
      )
    ).rejects.toThrow(/minSharesOut must be non-negative/);
    expect(prepareSorobanTx).not.toHaveBeenCalled();
  });
});

describe("buildCoordinatorWithdrawTx", () => {
  it("calls the vault's withdraw(caller, shares, min_usdc_out) with the correct ScVal args", async () => {
    const result = await buildCoordinatorWithdrawTx(
      { contractId: CONTRACT_ID, network },
      WALLET,
      50_000_000n,
      1_000_000n
    );

    expect(result).toEqual({ xdr: "UNSIGNED_XDR", fee: "150" });
    const [, , op] = vi.mocked(prepareSorobanTx).mock.calls[0]!;
    const invocation = op.body().invokeHostFunctionOp().hostFunction();
    expect(invocation.invokeContract().functionName().toString()).toBe(
      "withdraw"
    );
    const args = invocation.invokeContract().args();
    expect(args).toHaveLength(3);
    expect(Address.fromScVal(args[0]!).toString()).toBe(WALLET);
    expect(args[1]).toEqual(nativeToScVal(50_000_000n, { type: "i128" }));
    expect(args[2]).toEqual(nativeToScVal(1_000_000n, { type: "i128" }));
  });

  it("defaults min_usdc_out to 0n when omitted", async () => {
    await buildCoordinatorWithdrawTx(
      { contractId: CONTRACT_ID, network },
      WALLET,
      50_000_000n
    );
    const [, , op] = vi.mocked(prepareSorobanTx).mock.calls[0]!;
    const args = op
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
      .args();
    expect(args).toHaveLength(3);
    expect(args[2]).toEqual(nativeToScVal(0n, { type: "i128" }));
  });

  it("throws without calling prepareSorobanTx for non-positive shares", async () => {
    await expect(
      buildCoordinatorWithdrawTx(
        { contractId: CONTRACT_ID, network },
        WALLET,
        0n
      )
    ).rejects.toThrow(/shares must be positive/);
    expect(prepareSorobanTx).not.toHaveBeenCalled();
  });

  it("throws without calling prepareSorobanTx for a negative minUsdcOut", async () => {
    await expect(
      buildCoordinatorWithdrawTx(
        { contractId: CONTRACT_ID, network },
        WALLET,
        50_000_000n,
        -1n
      )
    ).rejects.toThrow(/minUsdcOut must be non-negative/);
    expect(prepareSorobanTx).not.toHaveBeenCalled();
  });
});

describe("fetchCoordinatorPosition", () => {
  function mockPositionCalls(opts: {
    shares: bigint;
    totalAssets?: bigint;
    totalShares?: bigint;
    principal?: bigint;
    entryTime?: bigint;
  }) {
    vi.mocked(simulateView).mockImplementation(
      async (_server, _contractId, _passphrase, method) => {
        switch (method) {
          case "get_position":
            return opts.shares as never;
          case "get_total_assets":
            return (opts.totalAssets ?? 0n) as never;
          case "get_total_shares":
            return (opts.totalShares ?? 0n) as never;
          case "get_principal":
            return (opts.principal ?? 0n) as never;
          case "get_entry_time":
            return (opts.entryTime ?? 0n) as never;
          default:
            throw new Error(
              `unexpected simulateView method: ${String(method)}`
            );
        }
      }
    );
  }

  it("returns [] without querying further when the address holds zero shares", async () => {
    mockPositionCalls({ shares: 0n });

    const positions = await fetchCoordinatorPosition(
      { contractId: CONTRACT_ID, network },
      "meridian-usdc",
      WALLET
    );

    expect(positions).toEqual([]);
    // Only get_position should have been called — no need to fetch the rest.
    expect(simulateView).toHaveBeenCalledTimes(1);
  });

  it("derives deposited, earned, and entryTime from on-chain values", async () => {
    // 100 shares out of 1000 total, vault holds 11_000 USDC worth of stroops
    // (1_100 with 7-decimal stroops) -> deposited = 100 * 11000 / 1000 = 1100 stroops-units.
    mockPositionCalls({
      shares: 100n,
      totalAssets: 11_000_0000000n,
      totalShares: 1_000_0000000n,
      principal: 1_000_0000000n,
      entryTime: 1_700_000_000n,
    });

    const positions = await fetchCoordinatorPosition(
      { contractId: CONTRACT_ID, network },
      "meridian-usdc",
      WALLET
    );

    expect(positions).toHaveLength(1);
    const [position] = positions;
    expect(position!.vaultId).toBe("meridian-usdc");
    expect(position!.shares).toBeCloseTo(0.00001, 8); // stroopsToUnits(100n)
    expect(position!.entryTime).toBe(1_700_000_000);
    expect(position!.deposited).toBeGreaterThan(0);
    expect(position!.earned).toBeGreaterThanOrEqual(0);
  });

  it("clamps earned to zero rather than reporting a negative value", async () => {
    // deposited value works out lower than principal (e.g. after a loss) —
    // earned must never go negative.
    mockPositionCalls({
      shares: 100n,
      totalAssets: 100_0000000n,
      totalShares: 1_000_0000000n,
      principal: 1_000_000_0000000n,
      entryTime: 0n,
    });

    const positions = await fetchCoordinatorPosition(
      { contractId: CONTRACT_ID, network },
      "meridian-usdc",
      WALLET
    );

    expect(positions[0]!.earned).toBe(0);
  });

  it("reports zero deposited when total shares is zero", async () => {
    // Guards the division by totalShares; shouldn't be reachable in practice
    // since a positive get_position implies totalShares > 0, but the derived
    // value must not be NaN/Infinity if it ever happens.
    mockPositionCalls({ shares: 100n, totalShares: 0n });

    const positions = await fetchCoordinatorPosition(
      { contractId: CONTRACT_ID, network },
      "meridian-usdc",
      WALLET
    );

    expect(positions[0]!.deposited).toBe(0);
  });

  it("reports zero earned, not the full balance, for a holder with no recorded basis", async () => {
    // mUSDC received by transfer (rather than deposit) carries no cost
    // basis: get_principal returns 0 for it, same as this suite's other
    // cases default to. Without the hasBasis guard, earned = deposited - 0
    // reports the holder's entire position as yield.
    mockPositionCalls({
      shares: 100n,
      totalAssets: 11_000_0000000n,
      totalShares: 1_000_0000000n,
      // principal omitted: defaults to 0n, i.e. "no basis recorded".
      entryTime: 0n,
    });

    const positions = await fetchCoordinatorPosition(
      { contractId: CONTRACT_ID, network },
      "meridian-usdc",
      WALLET
    );

    expect(positions[0]!.deposited).toBeGreaterThan(0);
    expect(positions[0]!.earned).toBe(0);
  });
});

describe("fetchVaultAdmin", () => {
  it("returns the admin address from get_admin", async () => {
    const ADMIN = "GCKFBEIYTKP6RCZNVPH73XL7XFJVSFAKQR4E4XQD4PGGPCCQTVMWXW6D";
    vi.mocked(simulateView).mockResolvedValue(ADMIN as never);

    const admin = await fetchVaultAdmin({ contractId: CONTRACT_ID, network });

    expect(admin).toBe(ADMIN);
    expect(simulateView).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_ID,
      network.passphrase,
      "get_admin"
    );
  });

  it("throws when get_admin doesn't resolve to a string", async () => {
    vi.mocked(simulateView).mockResolvedValue(null as never);

    await expect(
      fetchVaultAdmin({ contractId: CONTRACT_ID, network })
    ).rejects.toThrow(/unexpected response shape/);
  });
});

describe("fetchCoordinatorState", () => {
  const ADAPTER_ID = "CADAPTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2";

  function mockStateCalls(opts: {
    protocol?: string;
    totalShares?: bigint;
    totalAssets?: bigint;
    paused?: boolean;
  }) {
    vi.mocked(simulateView).mockImplementation(
      async (_server, _contractId, _passphrase, method) => {
        switch (method) {
          case "get_adapter":
            return ADAPTER_ID as never;
          case "get_protocol":
            return (opts.protocol ?? "blend") as never;
          case "get_total_shares":
            return (opts.totalShares ?? 0n) as never;
          case "get_total_assets":
            return (opts.totalAssets ?? 0n) as never;
          case "is_paused":
            return (opts.paused ?? false) as never;
          default:
            throw new Error(
              `unexpected simulateView method: ${String(method)}`
            );
        }
      }
    );
  }

  it("reads the active adapter's protocol, total shares/assets, and pause flag", async () => {
    mockStateCalls({
      protocol: "blend",
      totalShares: 1_000_0000000n,
      totalAssets: 1_050_0000000n,
      paused: false,
    });

    const state = await fetchCoordinatorState({
      contractId: CONTRACT_ID,
      network,
    });

    expect(state).toEqual({
      protocol: "blend",
      adapterId: ADAPTER_ID,
      totalShares: 1000,
      totalAssets: 1050,
      paused: false,
    });
  });

  it("reports paused: true when the vault is paused", async () => {
    mockStateCalls({ paused: true });
    const state = await fetchCoordinatorState({
      contractId: CONTRACT_ID,
      network,
    });
    expect(state.paused).toBe(true);
  });

  it("rounds shares/assets to 2 decimal places of human-readable units", async () => {
    // 12345678 stroops = 1.2345678 units, rounds to 1.23.
    mockStateCalls({ totalShares: 12_345_678n, totalAssets: 0n });
    const state = await fetchCoordinatorState({
      contractId: CONTRACT_ID,
      network,
    });
    expect(state.totalShares).toBe(1.23);
  });
});
