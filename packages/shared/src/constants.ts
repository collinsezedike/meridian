export const DEFAULT_ALLOWED_ORIGIN = "https://usemeridian.vercel.app";

export const SUPPORTED_STABLECOINS = ["USDC", "EURC"] as const;
export type SupportedStablecoin = (typeof SUPPORTED_STABLECOINS)[number];

export const PROTOCOL_IDS = ["blend", "defindex", "meridian"] as const;
export type ProtocolId = (typeof PROTOCOL_IDS)[number];

// Per-network classic Stellar asset issuers. Used for trustline setup and SAC
// address derivation. Testnet USDC is issued by Blend's controlled test key
// (not Circle) because Blend's TestnetV2 pool was deployed with that issuer.
export const USDC_ISSUER: Record<string, string> = {
  testnet: "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

// mUSDC is the vault's share token. Issuer = the DEPLOYER address used for
// that deployment's `scripts/deploy-testnet.sh` run (the script mints mUSDC
// as `MUSDC:$DEPLOYER_ADDRESS`, then hands admin control of the asset to the
// vault contract via set_admin). Frozen at mint time: unlike the vault's own
// admin, a classic Stellar asset's issuer can't be rotated after the fact,
// so this changes only when mUSDC itself is redeployed (i.e. together with
// CONTRACT_ADDRESSES.testnet.{vault,musdc} on a vault redeployment).
export const MUSDC_ISSUER: Record<string, string> = {
  testnet: "GBLYQ5EHXMMULOA7KA4KK2S5Q5GTTWYFVSC3FKLXRLH34EJX35BIAL35",
  mainnet: "",
};

export const CONTRACT_ADDRESSES = {
  testnet: {
    blend: {
      // Blend TestnetV2: the only active Blend lending pool on Stellar testnet.
      pool: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
    },
    defindex: {
      // DeFindex factory: defindex-io/stellar-contracts public/testnet.contracts.json
      factory: "CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32",
      // Paltalabs single-asset USDC vault on DeFindex testnet.
      vault: "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN",
    },
    // Stellar Asset Contract for Blend's testnet USDC (issuer: GATALTGTWIOT6...).
    // Distinct from Circle's testnet USDC; Blend's TestnetV2 pool was deployed
    // with this issuer. Obtain test tokens via testnet.blend.capital faucet.
    usdc: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
    // Stellar Asset Contract for Circle's testnet EURC (issuer: GB3Q6QDZYTHWT7...).
    eurc: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
    musdc: "CCSYXC4SDCPTGENHM6CSQY4HMSZOPOY5TJW4QYYLE5RDBUBJX4N7ZHV5",
    // Redeployed for #514: the previous vault (CBQYEHWIRJWIPWCJFQZAOP3VAZHRWFGAUS5GZHWFDDYKMFHJ5S3YS2Q5)
    // predates `migrate_adapter` and was never redeployed since #464/#507
    // added it. See apps/docs/operations/testnet-deployment.md's "Vault
    // migration history" for the old address, why it's stale, and the
    // pre-cutover withdrawal window for anyone still holding a position there.
    vault: "CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL",
  },
  mainnet: {
    blend: {
      // Mainnet Blend pool addresses are resolved at runtime via DeFiLlama pool
      // UUIDs in KNOWN_POOLS (packages/stellar-sdk-helpers/src/known-pools.ts).
      // A single pool address is not sufficient; each ranked pool has its own
      // contract. Populate per-pool addresses here before enabling mainnet tx building.
      pool: "",
    },
    defindex: {
      factory: "",
      vault: "",
    },
    // Stellar Asset Contract for Circle's mainnet USDC (issuer: GA5ZSEJYB37J...).
    usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    // Stellar Asset Contract for Circle's mainnet EURC (issuer: GDHU6WRG4IEQ...).
    eurc: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
    musdc: "",
    vault: "",
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

const _networkKey = (
  process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet"
) satisfies keyof typeof STELLAR_NETWORKS;

export const APP_NETWORK = STELLAR_NETWORKS[_networkKey];
export const APP_ADDRESSES = CONTRACT_ADDRESSES[_networkKey];

export function isDefindexConfigured(): boolean {
  return Boolean(process.env.DEFINDEX_VAULT_ID ?? APP_ADDRESSES.defindex.vault);
}
