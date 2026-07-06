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

export interface ProtocolAddresses {
  usdc: string;
  eurc: string;
}

/**
 * Look up the registry entry for `vaultId` on the given network. Throws if the
 * vault is unknown or its contract address is not yet configured.
 */
function resolveVaultEntry(vaultId: string, network: StellarNetwork) {
  const pools =
    network.network === "testnet" ? KNOWN_POOLS.testnet : KNOWN_POOLS.mainnet;
  const entry = Object.values(pools).find((p) => p.id === vaultId);
  if (!entry?.contractId) {
    throw new Error(
      `Vault not configured: ${vaultId}. Add it to KNOWN_POOLS with a contractId.`
    );
  }
  return { ...entry, contractId: entry.contractId };
}

/**
 * Build an unsigned deposit transaction for the vault identified by `vaultId`.
 * Routes to the correct protocol by looking up the vault in KNOWN_POOLS. Throws
 * if the vault is unregistered, its contract is unconfigured, or its protocol
 * prefix is unrecognised.
 */
export async function buildDepositTx(
  vaultId: string,
  walletAddress: string,
  amount: string,
  addresses: ProtocolAddresses,
  network: StellarNetwork
): Promise<{ xdr: string; fee: string }> {
  const entry = resolveVaultEntry(vaultId, network);
  if (resolveProtocol(vaultId) === "Blend") {
    const assetKey = blendAssetForVault(vaultId);
    return buildBlendDepositTx(
      { poolId: entry.contractId, assetId: addresses[assetKey], network },
      walletAddress,
      toStroops(amount)
    );
  }
  return buildDefindexDepositTx(
    { vaultId: entry.contractId, network },
    walletAddress,
    toStroops(amount)
  );
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
  const entry = resolveVaultEntry(vaultId, network);
  if (resolveProtocol(vaultId) === "Blend") {
    const assetKey = blendAssetForVault(vaultId);
    return buildBlendWithdrawTx(
      { poolId: entry.contractId, assetId: addresses[assetKey], network },
      walletAddress,
      toStroops(shares)
    );
  }
  return buildDefindexWithdrawTx(
    { vaultId: entry.contractId, network },
    walletAddress,
    toStroops(shares)
  );
}

/**
 * Fetches all positions for `publicKey` across every registered vault on the
 * given network. Blend vaults that share a pool contract are batched into one
 * RPC call; each DeFindex vault is fetched independently. Failures from any
 * single source are logged and suppressed so partial results are always returned.
 */
export async function resolvePositions(
  publicKey: string,
  network: StellarNetwork,
  addresses: ProtocolAddresses
): Promise<PositionInfo[]> {
  const pools = Object.values(
    network.network === "testnet" ? KNOWN_POOLS.testnet : KNOWN_POOLS.mainnet
  );

  // Group Blend reserves by pool contract so vaults sharing a pool get one fetch.
  const blendGroups = new Map<
    string,
    Array<{ assetId: string; vaultId: string }>
  >();
  for (const pool of pools) {
    if (pool.protocol !== "blend" || !pool.contractId) continue;
    const assetKey = blendAssetForVault(pool.id);
    if (!blendGroups.has(pool.contractId)) blendGroups.set(pool.contractId, []);
    blendGroups
      .get(pool.contractId)!
      .push({ assetId: addresses[assetKey], vaultId: pool.id });
  }

  const dfxPools = pools.filter(
    (p): p is typeof p & { contractId: string } =>
      p.protocol === "defindex" && Boolean(p.contractId)
  );

  const results = await Promise.allSettled([
    ...[...blendGroups.entries()].map(([poolId, reserves]) =>
      fetchBlendPositions(network, poolId, publicKey, reserves)
    ),
    ...dfxPools.map((p) =>
      fetchDefindexPosition(network, p.contractId, p.id, publicKey)
    ),
  ]);

  const positions: PositionInfo[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      positions.push(...result.value);
    } else {
      console.error("[positions] fetch failed:", result.reason);
    }
  }
  return positions;
}
