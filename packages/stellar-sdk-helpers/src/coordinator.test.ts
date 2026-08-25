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
  it("calls the vault's deposit(caller, amount) with the correct ScVal args", async () => {
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
    // with the caller's address and the i128 amount, in that order.
    const invocation = op.body().invokeHostFunctionOp().hostFunction();
    const args = invocation.invokeContract().args();
    expect(args).toHaveLength(2);
    expect(Address.fromScVal(args[0]!).toString()).toBe(WALLET);
    expect(args[1]).toEqual(nativeToScVal(100_000_000n, { type: "i128" }));
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
});

describe("buildCoordinatorWithdrawTx", () => {
  it("calls the vault's withdraw(caller, shares) with the correct ScVal args", async () => {
    const result = await buildCoordinatorWithdrawTx(
      { contractId: CONTRACT_ID, network },
      WALLET,
      50_000_000n
    );

    expect(result).toEqual({ xdr: "UNSIGNED_XDR", fee: "150" });
    const [, , op] = vi.mocked(prepareSorobanTx).mock.calls[0]!;
    const invocation = op.body().invokeHostFunctionOp().hostFunction();
    expect(invocation.invokeContract().functionName().toString()).toBe(
      "withdraw"
    );
    const args = invocation.invokeContract().args();
    expect(Address.fromScVal(args[0]!).toString()).toBe(WALLET);
    expect(args[1]).toEqual(nativeToScVal(50_000_000n, { type: "i128" }));
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
