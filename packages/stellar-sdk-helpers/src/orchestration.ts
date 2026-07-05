import {
  buildBlendDepositTx,
  buildBlendWithdrawTx,
  blendAssetForVault,
  fetchBlendPositions,
} from "./blend";
import {
  buildDefindexDepositTx,
  buildDefindexWithdrawTx,
  fetchDefindexPosition,
} from "./defindex";
import { toStroops, resolveProtocol } from "./tx";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";
import { KNOWN_POOLS } from "./known-pools";

function blendPositionEntries(
  network: StellarNetwork,
  addresses: ProtocolAddresses
): Array<{ assetId: string; vaultId: string }> {
  const pools =
    network.network === "testnet"
      ? Object.values(KNOWN_POOLS.testnet)
      : Object.values(KNOWN_POOLS.mainnet);
  const seen = new Set<string>();
  const entries: Array<{ assetId: string; vaultId: string }> = [];
  for (const pool of pools) {
    if (pool.protocol !== "blend") continue;
    const assetKey = blendAssetForVault(pool.id);
    if (seen.has(assetKey)) continue;
    seen.add(assetKey);
    entries.push({ assetId: addresses[assetKey], vaultId: pool.id });
  }
  return entries;
}

export interface ProtocolAddresses {
  blendPool: string;
  usdc: string;
  eurc: string;
  defindexVault: string;
  defindexVaultId: string;
}

/**
 * Build an unsigned deposit transaction for the vault identified by `vaultId`.
 * Routes to Blend or DeFindex based on the vault ID prefix and returns the
 * unsigned XDR and estimated fee. Throws if the vault protocol is unrecognised
 * or the required contract address is not configured.
 */
export async function buildDepositTx(
  vaultId: string,
  walletAddress: string,
  amount: string,
  addresses: ProtocolAddresses,
  network: StellarNetwork
): Promise<{ xdr: string; fee: string }> {
  if (resolveProtocol(vaultId) === "Blend") {
    const asset = blendAssetForVault(vaultId);
    return buildBlendDepositTx(
      { poolId: addresses.blendPool, assetId: addresses[asset], network },
      walletAddress,
      toStroops(amount)
    );
  }
  if (!addresses.defindexVault) {
    throw new Error("DeFindex vault not configured. Set DEFINDEX_VAULT_ID.");
  }
  return buildDefindexDepositTx(
    { vaultId: addresses.defindexVault, network },
    walletAddress,
    toStroops(amount)
  );
}

/**
 * Fetches all positions for `publicKey` across Blend reserves and (optionally)
 * the DeFindex vault. Each source is fetched independently: a failure in one
 * (e.g. RPC timeout, user has no Blend entry) does not suppress positions from
 * the other. Both failures are logged; partial results are returned.
 */
export async function resolvePositions(
  publicKey: string,
  network: StellarNetwork,
  addresses: ProtocolAddresses
): Promise<PositionInfo[]> {
  const [blendResult, dfxResult] = await Promise.allSettled([
    fetchBlendPositions(
      network,
      addresses.blendPool,
      publicKey,
      blendPositionEntries(network, addresses)
    ),
    addresses.defindexVault
      ? fetchDefindexPosition(
          network,
          addresses.defindexVault,
          addresses.defindexVaultId,
          publicKey
        )
      : Promise.resolve([]),
  ]);

  if (blendResult.status === "rejected") {
    console.error("[positions] Blend fetch failed:", blendResult.reason);
  }
  if (dfxResult.status === "rejected") {
    console.error("[positions] DeFindex fetch failed:", dfxResult.reason);
  }

  const blendPositions =
    blendResult.status === "fulfilled" ? blendResult.value : [];
  const dfxPositions = dfxResult.status === "fulfilled" ? dfxResult.value : [];

  return [...blendPositions, ...dfxPositions];
}

/**
 * Build an unsigned withdrawal transaction for the vault identified by `vaultId`.
 * `shares` is the protocol share count to burn: bToken collateral for Blend,
 * dfToken count for DeFindex. Routes and throws on the same conditions as
 * `buildDepositTx`.
 */
export async function buildWithdrawTx(
  vaultId: string,
  walletAddress: string,
  shares: string,
  addresses: ProtocolAddresses,
  network: StellarNetwork
): Promise<{ xdr: string; fee: string }> {
  if (resolveProtocol(vaultId) === "Blend") {
    const asset = blendAssetForVault(vaultId);
    return buildBlendWithdrawTx(
      { poolId: addresses.blendPool, assetId: addresses[asset], network },
      walletAddress,
      toStroops(shares)
    );
  }
  if (!addresses.defindexVault) {
    throw new Error("DeFindex vault not configured. Set DEFINDEX_VAULT_ID.");
  }
  return buildDefindexWithdrawTx(
    { vaultId: addresses.defindexVault, network },
    walletAddress,
    toStroops(shares)
  );
}
