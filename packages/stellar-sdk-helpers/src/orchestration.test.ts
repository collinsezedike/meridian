import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildDepositTx,
  buildWithdrawTx,
  resolvePositions,
  type ProtocolAddresses,
} from "./orchestration";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";

const BLEND_USDC: PositionInfo = {
  vaultId: "blend-usdc-fixed",
  shares: 10,
  deposited: 10,
  earned: 0,
  entryTime: 0,
};
const DFX_USDC: PositionInfo = {
  vaultId: "defindex-usdc",
  shares: 5,
  deposited: 5,
  earned: 0,
  entryTime: 0,
};

vi.mock("./known-pools", () => ({
  KNOWN_POOLS: {
    testnet: {
      "blend-testnet-usdc": {
        id: "blend-usdc-fixed",
        protocol: "blend",
        contractId: "CPOOL",
        assetId: "CUSDC",
        asset: "USDC",
      },
      "blend-testnet-eurc": {
        id: "blend-eurc-fixed",
        protocol: "blend",
        contractId: "CPOOL",
        assetId: "CEURC",
        asset: "EURC",
      },
      "defindex-usdc": {
        id: "defindex-usdc",
        protocol: "defindex",
        contractId: "CDFX",
        assetId: "CUSDC",
        asset: "USDC",
      },
    },
    mainnet: {},
  },
}));

vi.mock("./blend", () => ({
  blendAssetForVault: vi.fn((vaultId: string) =>
    vaultId.includes("-eurc") ? "eurc" : "usdc"
  ),
  buildBlendDepositTx: vi.fn(async () => ({
    xdr: "BLEND_DEPOSIT_XDR",
    fee: "200",
  })),
  buildBlendWithdrawTx: vi.fn(async () => ({
    xdr: "BLEND_WITHDRAW_XDR",
    fee: "200",
  })),
  fetchBlendPositions: vi.fn(async () => [BLEND_USDC]),
}));

vi.mock("./defindex", () => ({
  buildDefindexDepositTx: vi.fn(async () => ({
    xdr: "DFX_DEPOSIT_XDR",
    fee: "300",
  })),
  buildDefindexWithdrawTx: vi.fn(async () => ({
    xdr: "DFX_WITHDRAW_XDR",
    fee: "300",
  })),
  fetchDefindexPosition: vi.fn(async () => [DFX_USDC]),
}));

import {
  buildBlendDepositTx,
  buildBlendWithdrawTx,
  fetchBlendPositions,
} from "./blend";
import {
  buildDefindexDepositTx,
  buildDefindexWithdrawTx,
  fetchDefindexPosition,
} from "./defindex";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const addresses: ProtocolAddresses = {
  usdc: "CUSDC",
  eurc: "CEURC",
};

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => vi.clearAllMocks());

describe("buildDepositTx", () => {
  it("routes a blend-usdc vault to buildBlendDepositTx with the USDC asset", async () => {
    const result = await buildDepositTx(
      "blend-usdc-fixed",
      WALLET,
      "10",
      addresses,
      network
    );
    expect(result).toEqual({ xdr: "BLEND_DEPOSIT_XDR", fee: "200" });
    expect(buildBlendDepositTx).toHaveBeenCalledWith(
      { poolId: "CPOOL", assetId: "CUSDC", network },
      WALLET,
      100_000_000n
    );
    expect(buildDefindexDepositTx).not.toHaveBeenCalled();
  });

  it("routes a blend-eurc vault to buildBlendDepositTx with the EURC asset", async () => {
    await buildDepositTx("blend-eurc-fixed", WALLET, "5", addresses, network);
    expect(buildBlendDepositTx).toHaveBeenCalledWith(
      { poolId: "CPOOL", assetId: "CEURC", network },
      WALLET,
      50_000_000n
    );
  });

  it("routes a defindex vault to buildDefindexDepositTx", async () => {
    const result = await buildDepositTx(
      "defindex-usdc",
      WALLET,
      "10",
      addresses,
      network
    );
    expect(result).toEqual({ xdr: "DFX_DEPOSIT_XDR", fee: "300" });
    expect(buildDefindexDepositTx).toHaveBeenCalledWith(
      { vaultId: "CDFX", network },
      WALLET,
      100_000_000n
    );
    expect(buildBlendDepositTx).not.toHaveBeenCalled();
  });

  it("throws for a vault not in KNOWN_POOLS", async () => {
    await expect(
      buildDepositTx("defindex-eurc", WALLET, "10", addresses, network)
    ).rejects.toThrow(/Vault not configured/);
  });

  it("throws for an unrecognised vault protocol", async () => {
    await expect(
      buildDepositTx("ondo-usdy", WALLET, "10", addresses, network)
    ).rejects.toThrow();
  });
});

describe("buildWithdrawTx", () => {
  it("routes a blend vault to buildBlendWithdrawTx", async () => {
    const result = await buildWithdrawTx(
      "blend-usdc-fixed",
      WALLET,
      "5",
      addresses,
      network
    );
    expect(result).toEqual({ xdr: "BLEND_WITHDRAW_XDR", fee: "200" });
    expect(buildBlendWithdrawTx).toHaveBeenCalledWith(
      { poolId: "CPOOL", assetId: "CUSDC", network },
      WALLET,
      50_000_000n
    );
  });

  it("routes a defindex vault to buildDefindexWithdrawTx", async () => {
    const result = await buildWithdrawTx(
      "defindex-usdc",
      WALLET,
      "5",
      addresses,
      network
    );
    expect(result).toEqual({ xdr: "DFX_WITHDRAW_XDR", fee: "300" });
    expect(buildDefindexWithdrawTx).toHaveBeenCalledWith(
      { vaultId: "CDFX", network },
      WALLET,
      50_000_000n
    );
  });

  it("throws for a vault not in KNOWN_POOLS", async () => {
    await expect(
      buildWithdrawTx("defindex-eurc", WALLET, "5", addresses, network)
    ).rejects.toThrow(/Vault not configured/);
  });

  it("throws for an unrecognised vault protocol", async () => {
    await expect(
      buildWithdrawTx("ondo-usdy", WALLET, "5", addresses, network)
    ).rejects.toThrow();
  });
});

describe("resolvePositions", () => {
  it("calls fetchBlendPositions with the pool contract and reserves from KNOWN_POOLS", async () => {
    const positions = await resolvePositions(WALLET, network, addresses);
    expect(fetchBlendPositions).toHaveBeenCalledWith(network, "CPOOL", WALLET, [
      { assetId: "CUSDC", vaultId: "blend-usdc-fixed" },
      { assetId: "CEURC", vaultId: "blend-eurc-fixed" },
    ]);
    expect(positions).toContainEqual(BLEND_USDC);
  });

  it("fetches DeFindex positions for every DeFindex vault in KNOWN_POOLS", async () => {
    const positions = await resolvePositions(WALLET, network, addresses);
    expect(fetchDefindexPosition).toHaveBeenCalledWith(
      network,
      "CDFX",
      "defindex-usdc",
      WALLET
    );
    expect(positions).toContainEqual(DFX_USDC);
  });

  it("returns Blend positions when DeFindex fetch fails", async () => {
    vi.mocked(fetchDefindexPosition).mockRejectedValueOnce(
      new Error("RPC down")
    );
    const positions = await resolvePositions(WALLET, network, addresses);
    expect(positions).toEqual([BLEND_USDC]);
  });

  it("returns DeFindex positions when Blend fetch fails", async () => {
    vi.mocked(fetchBlendPositions).mockRejectedValueOnce(
      new Error("Blend RPC timeout")
    );
    const positions = await resolvePositions(WALLET, network, addresses);
    expect(positions).toEqual([DFX_USDC]);
  });

  it("returns empty array when all fetches fail", async () => {
    vi.mocked(fetchBlendPositions).mockRejectedValueOnce(
      new Error("Blend down")
    );
    vi.mocked(fetchDefindexPosition).mockRejectedValueOnce(
      new Error("DeFindex down")
    );
    const positions = await resolvePositions(WALLET, network, addresses);
    expect(positions).toEqual([]);
  });
});
