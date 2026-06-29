export const DEFAULT_ALLOWED_ORIGIN = "https://usemeridian.vercel.app";

export const SUPPORTED_STABLECOINS = ["USDC", "EURC"] as const;
export type SupportedStablecoin = (typeof SUPPORTED_STABLECOINS)[number];

export const PROTOCOL_IDS = ["blend", "defindex"] as const;
export type ProtocolId = (typeof PROTOCOL_IDS)[number];

// Testnet contract addresses — replace with mainnet before launch
export const CONTRACT_ADDRESSES = {
  testnet: {
    blend: {
      pool: "CBDIZZTC5VFJHMKDXP4ADLSXMF6NE5LOFQBZ7XPWLH7FRDVYQKTJF5",
    },
    defindex: {
      factory: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK75",
      // Single-asset (USDC) DeFindex vault. Empty until a real testnet vault is
      // wired — until then DeFindex routes report "not configured" rather than
      // pointing at a placeholder. Override at runtime with DEFINDEX_VAULT_ID.
      vault: "",
    },
    usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    eurc: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
    musdc: "CAHOYJV2D4IGNZUQ5NP3HTXQL2LQ47YTP3TR56MHR5CJEWHGMEUYRIL3",
    vault: "CBK5RI4BCA7TLSD2S5Q5TH2LUQAT55GF34OBTWPFUKWZ5O6YXSQDAWOJ",
  },
} as const;

export const STELLAR_NETWORKS = {
  testnet: {
    network: "testnet" as const,
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    network: "mainnet" as const,
    rpcUrl: "https://soroban-mainnet.stellar.org",
    passphrase: "Public Global Stellar Network ; September 2015",
  },
};

// Convenience aliases — both API layers (Vercel + Fastify) target testnet today.
export const APP_NETWORK = STELLAR_NETWORKS.testnet;
export const APP_ADDRESSES = CONTRACT_ADDRESSES.testnet;

export function isDefindexConfigured(): boolean {
  return Boolean(process.env.DEFINDEX_VAULT_ID ?? APP_ADDRESSES.defindex.vault);
}

/** Build the ProtocolAddresses object consumed by stellar-sdk-helpers, allowing
 *  the DeFindex vault id to be overridden at runtime via DEFINDEX_VAULT_ID. */
export function buildTxAddresses(defindexOverride?: string) {
  return {
    blendPool: APP_ADDRESSES.blend.pool,
    usdc: APP_ADDRESSES.usdc,
    eurc: APP_ADDRESSES.eurc,
    defindexVault: defindexOverride ?? APP_ADDRESSES.defindex.vault,
  };
}
