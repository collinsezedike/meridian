import { buildBlendDepositTx, buildBlendWithdrawTx, blendAssetForVault, fetchBlendPositions } from "./blend";
import { buildDefindexDepositTx, buildDefindexWithdrawTx, fetchDefindexPosition } from "./defindex";
import { toStroops, resolveProtocol } from "./tx";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";

export interface ProtocolAddresses {
  blendPool: string;
  usdc: string;
  eurc: string;
  defindexVault: string;
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
 * the DeFindex vault. Errors from either protocol propagate to the caller.
 */
export async function resolvePositions(
  publicKey: string,
  network: StellarNetwork,
  addresses: ProtocolAddresses,
): Promise<PositionInfo[]> {
  const positions = await fetchBlendPositions(network, addresses.blendPool, publicKey, [
    { assetId: addresses.usdc, vaultId: "blend-usdc-fixed" },
    { assetId: addresses.eurc, vaultId: "blend-eurc-fixed" },
  ]);

  if (addresses.defindexVault) {
    const dfx = await fetchDefindexPosition(network, addresses.defindexVault, "defindex-usdc", publicKey);
    positions.push(...dfx);
  }

  return positions;
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
