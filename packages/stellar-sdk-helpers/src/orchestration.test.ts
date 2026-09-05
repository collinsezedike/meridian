import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildDepositTx,
  buildWithdrawTx,
  resolvePositions,
} from "./orchestration";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";

const VAULT_CONTRACT =
  "CBK5RI4BCA7TLSD2S5Q5TH2LUQAT55GF34OBTWPFUKWZ5O6YXSQDAWOJ";
const VAULT2_CONTRACT =
  "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";

const MERIDIAN_USDC: PositionInfo = {
  vaultId: "meridian-usdc",
  shares: 10,
  deposited: 10,
  earned: 0,
  entryTime: 0,
};

const MERIDIAN_EURC: PositionInfo = {
  vaultId: "meridian-eurc",
  shares: 5,
  deposited: 5,
  earned: 0,
  entryTime: 0,
};

vi.mock("./known-pools", () => ({
  KNOWN_POOLS: {
    testnet: {
      "meridian-usdc": {
        id: "meridian-usdc",
        protocol: "meridian",
        contractId: "CBK5RI4BCA7TLSD2S5Q5TH2LUQAT55GF34OBTWPFUKWZ5O6YXSQDAWOJ",
        assetId: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
        asset: "USDC",
      },
      "meridian-eurc": {
        id: "meridian-eurc",
        protocol: "meridian",
        contractId: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
        assetId: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
        asset: "EURC",
      },
    },
    mainnet: {},
  },
}));

vi.mock("./coordinator", () => ({
  buildCoordinatorDepositTx: vi.fn(async () => ({
    xdr: "COORDINATOR_DEPOSIT_XDR",
    fee: "200",
  })),
  buildCoordinatorWithdrawTx: vi.fn(async () => ({
    xdr: "COORDINATOR_WITHDRAW_XDR",
    fee: "200",
  })),
  fetchCoordinatorPosition: vi.fn(async (_config: unknown, vaultId: string) =>
    vaultId === "meridian-usdc" ? [MERIDIAN_USDC] : [MERIDIAN_EURC]
  ),
}));

import {
  buildCoordinatorDepositTx,
  buildCoordinatorWithdrawTx,
  fetchCoordinatorPosition,
} from "./coordinator";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => vi.clearAllMocks());

describe("buildDepositTx", () => {
  it("routes a meridian vault deposit through buildCoordinatorDepositTx", async () => {
    const result = await buildDepositTx("meridian-usdc", WALLET, "10", network);
    expect(result).toEqual({ xdr: "COORDINATOR_DEPOSIT_XDR", fee: "200" });
    expect(buildCoordinatorDepositTx).toHaveBeenCalledWith(
      { contractId: VAULT_CONTRACT, network },
      WALLET,
      100_000_000n,
      0n
    );
  });

  it("passes minSharesOut when supplied", async () => {
    await buildDepositTx("meridian-usdc", WALLET, "10", network, "9.5");
    expect(buildCoordinatorDepositTx).toHaveBeenCalledWith(
      { contractId: VAULT_CONTRACT, network },
      WALLET,
      100_000_000n,
      95_000_000n
    );
  });

  it("throws for a vault not in KNOWN_POOLS", async () => {
    await expect(
      buildDepositTx("unknown-vault", WALLET, "10", network)
    ).rejects.toThrow(/Vault not configured/);
  });
});

describe("buildWithdrawTx", () => {
  it("routes a meridian vault withdrawal through buildCoordinatorWithdrawTx", async () => {
    const result = await buildWithdrawTx("meridian-usdc", WALLET, "5", network);
    expect(result).toEqual({ xdr: "COORDINATOR_WITHDRAW_XDR", fee: "200" });
    expect(buildCoordinatorWithdrawTx).toHaveBeenCalledWith(
      { contractId: VAULT_CONTRACT, network },
      WALLET,
      50_000_000n,
      0n
    );
  });

  it("forwards min_usdc_out as stroops to buildCoordinatorWithdrawTx", async () => {
    await buildWithdrawTx("meridian-usdc", WALLET, "5", network, "4.8");
    expect(buildCoordinatorWithdrawTx).toHaveBeenCalledWith(
      { contractId: VAULT_CONTRACT, network },
      WALLET,
      50_000_000n,
      48_000_000n
    );
  });

  it("throws for a vault not in KNOWN_POOLS", async () => {
    await expect(
      buildWithdrawTx("unknown-vault", WALLET, "5", network)
    ).rejects.toThrow(/Vault not configured/);
  });
});

describe("resolvePositions", () => {
  it("calls fetchCoordinatorPosition for every meridian vault in KNOWN_POOLS", async () => {
    const positions = await resolvePositions(WALLET, network);
    expect(fetchCoordinatorPosition).toHaveBeenCalledWith(
      { contractId: VAULT_CONTRACT, network },
      "meridian-usdc",
      WALLET
    );
    expect(fetchCoordinatorPosition).toHaveBeenCalledWith(
      { contractId: VAULT2_CONTRACT, network },
      "meridian-eurc",
      WALLET
    );
    expect(positions).toContainEqual(MERIDIAN_USDC);
    expect(positions).toContainEqual(MERIDIAN_EURC);
  });

  it("returns partial results when one vault fetch fails", async () => {
    vi.mocked(fetchCoordinatorPosition).mockImplementationOnce(async () => {
      throw new Error("RPC down");
    });
    const positions = await resolvePositions(WALLET, network);
    expect(positions).toHaveLength(1);
  });

  it("returns empty array when all vault fetches fail", async () => {
    vi.mocked(fetchCoordinatorPosition).mockRejectedValue(
      new Error("RPC down")
    );
    const positions = await resolvePositions(WALLET, network);
    expect(positions).toEqual([]);
  });
});
