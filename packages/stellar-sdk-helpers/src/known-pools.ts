export interface KnownPoolMeta {
  id: string;
  name: string;
  protocol: "blend" | "defindex" | "meridian";
  label: string;
  // The main protocol contract for this vault: lending pool address for Blend,
  // vault contract address for DeFindex, coordinator vault address for Meridian.
  // Optional on mainnet until deployed.
  contractId?: string;
}

export interface TestnetPoolMeta extends KnownPoolMeta {
  contractId: string;
  assetId: string;
  asset: string;
}

// Mainnet keys are DeFiLlama pool UUIDs (yields.llama.fi/pools) matched against
// live APY/TVL data. Testnet keys are internal identifiers; DeFiLlama does not
// index testnet pools, so testnet vaults are populated from on-chain data directly.
export const KNOWN_POOLS: {
  mainnet: Record<string, KnownPoolMeta>;
  testnet: Record<string, TestnetPoolMeta>;
} = {
  mainnet: {
    "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf": {
      id: "blend-usdc-fixed",
      name: "Blend Capital",
      protocol: "blend",
      label: "Fixed Pool",
    },
    "3a61420f-6f6e-45f9-accc-8d23f5a32d33": {
      id: "blend-eurc-fixed",
      name: "Blend Capital",
      protocol: "blend",
      label: "Fixed Pool",
    },
    "48c597dc-9367-4b4a-aa10-49b9755c4c2e": {
      id: "blend-usdc-variable",
      name: "Blend Capital",
      protocol: "blend",
      label: "Variable Pool",
    },
    "9a2f1f81-0a6e-441d-8219-c13b3520bd57": {
      id: "blend-eurc-variable",
      name: "Blend Capital",
      protocol: "blend",
      label: "Variable Pool",
    },
  },
  testnet: {
    // Meridian coordinator vault: protocol-agnostic entry point. The vault
    // routes to its active adapter (Blend or DeFindex) transparently.
    // contractId is updated after each redeployment.
    "meridian-usdc": {
      id: "meridian-usdc",
      name: "Meridian",
      protocol: "meridian",
      label: "USDC Vault",
      contractId: "CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL",
      assetId: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
      asset: "USDC",
    },
  },
};
