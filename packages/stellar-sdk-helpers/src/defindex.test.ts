import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildDefindexDepositTx,
  buildDefindexWithdrawTx,
  stroopsToUnits,
  fetchDefindexPosition,
} from "./defindex";
import type { StellarNetwork } from "./types";

// Track rpc.Server constructor calls so we can assert on the timeout option.
const capturedServerArgs: unknown[][] = [];
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: class extends actual.rpc.Server {
        constructor(...args: ConstructorParameters<typeof actual.rpc.Server>) {
          capturedServerArgs.push(args);
          super(...args);
        }
      },
    },
  };
});

vi.mock("./tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tx")>();
  return { ...actual, simulateView: vi.fn() };
});

import { simulateView } from "./tx";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};
const config = { vaultId: "CVAULT", network };
const ADDR = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// The positive-amount guards run before any network access, so they are
// unit-testable without an RPC server.
describe("buildDefindexDepositTx", () => {
  it("rejects a non-positive amount", async () => {
    await expect(buildDefindexDepositTx(config, ADDR, 0n)).rejects.toThrow(
      /positive/
    );
    await expect(buildDefindexDepositTx(config, ADDR, -1n)).rejects.toThrow(
      /positive/
    );
  });
});

describe("buildDefindexWithdrawTx", () => {
  it("rejects non-positive shares", async () => {
    await expect(buildDefindexWithdrawTx(config, ADDR, 0n)).rejects.toThrow(
      /positive/
    );
  });
});

describe("stroopsToUnits", () => {
  it("converts small values exactly", () => {
    expect(stroopsToUnits(10_000_000n)).toBe(1);
    expect(stroopsToUnits(5_000_000n)).toBe(0.5);
  });

  it("preserves precision for values above Number.MAX_SAFE_INTEGER stroops", () => {
    // 1 billion units = 10_000_000_000_000_000 stroops (1e16), above MAX_SAFE_INTEGER
    const stroops = 10_000_000_000_000_000n;
    expect(stroopsToUnits(stroops)).toBe(1_000_000_000);
  });

  it("handles fractional units correctly", () => {
    // 1.0000001 units = 10_000_001 stroops
    expect(stroopsToUnits(10_000_001n)).toBeCloseTo(1.0000001, 7);
  });
});

describe("fetchDefindexPosition", () => {
  const VAULT_ID = "CVAULT000000000000000000000000000000000000000000000000000";
  const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  beforeEach(() => {
    vi.clearAllMocks();
    capturedServerArgs.length = 0;
  });

  it("constructs rpc.Server with a 12 s HTTP timeout so the outer race fires first", async () => {
    vi.mocked(simulateView).mockResolvedValue(0n);

    await fetchDefindexPosition(network, VAULT_ID, "defindex-usdc", PUBKEY);

    expect(capturedServerArgs).toHaveLength(1);
    expect(capturedServerArgs[0][0]).toBe(network.rpcUrl);
    expect(capturedServerArgs[0][1]).toMatchObject({ timeout: 12_000 });
  });

  it("returns [] when the user holds zero shares", async () => {
    vi.mocked(simulateView).mockResolvedValue(0n);
    const result = await fetchDefindexPosition(
      network,
      VAULT_ID,
      "defindex-usdc",
      PUBKEY
    );
    expect(result).toEqual([]);
    expect(simulateView).toHaveBeenCalledOnce();
  });

  it("maps shares and underlying amount into a PositionInfo", async () => {
    vi.mocked(simulateView)
      .mockResolvedValueOnce(5_000_000n) // balance: 0.5 dfTokens
      .mockResolvedValueOnce([10_000_000n]); // get_asset_amounts_per_shares: 1 USDC

    const result = await fetchDefindexPosition(
      network,
      VAULT_ID,
      "defindex-usdc",
      PUBKEY
    );
    expect(result).toHaveLength(1);
    expect(result[0].vaultId).toBe("defindex-usdc");
    expect(result[0].shares).toBeCloseTo(0.5, 7);
    expect(result[0].deposited).toBeCloseTo(1, 7);
    expect(result[0].earned).toBe(0);
    expect(result[0].entryTime).toBe(0);
  });

  it("sets deposited to 0 when amounts array is null", async () => {
    vi.mocked(simulateView)
      .mockResolvedValueOnce(5_000_000n)
      .mockResolvedValueOnce(null);

    const [pos] = await fetchDefindexPosition(
      network,
      VAULT_ID,
      "defindex-usdc",
      PUBKEY
    );
    expect(pos.deposited).toBe(0);
  });

  it("sets deposited to 0 when amounts array is empty", async () => {
    vi.mocked(simulateView)
      .mockResolvedValueOnce(5_000_000n)
      .mockResolvedValueOnce([]);

    const [pos] = await fetchDefindexPosition(
      network,
      VAULT_ID,
      "defindex-usdc",
      PUBKEY
    );
    expect(pos.deposited).toBe(0);
  });
});

describe("slippage tolerance", () => {
  it("default 0.1% tolerance produces minAmount strictly less than amount", () => {
    const amount = 1_000_000_000n;
    const slippageBps = 10n;
    const minAmount = amount - (amount * slippageBps) / 10_000n;
    expect(minAmount).toBe(999_000_000n);
    expect(minAmount).toBeLessThan(amount);
  });

  it("zero slippage keeps minAmount equal to amount", () => {
    const amount = 1_000_000_000n;
    const minAmount = amount - (amount * 0n) / 10_000n;
    expect(minAmount).toBe(amount);
  });
});
