import { toStroops } from "./tx";
import {
  buildCoordinatorDepositTx,
  buildCoordinatorWithdrawTx,
  fetchCoordinatorPosition,
} from "./coordinator";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";
import { KNOWN_POOLS } from "./known-pools";

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
 * Build an unsigned deposit transaction for the coordinator vault identified
 * by `vaultId`. All deposits route through the coordinator regardless of the
 * underlying protocol; the active adapter handles protocol-specific logic.
 * `minSharesOut` is the minimum mUSDC shares the caller is willing to receive;
 * the vault rejects the call with `SlippageExceeded` if minted shares fall below it.
 * Defaults to `"0"` (no slippage protection) when omitted.
 */
export async function buildDepositTx(
  vaultId: string,
  walletAddress: string,
  amount: string,
  network: StellarNetwork,
  minSharesOut: string = "0"
): Promise<{ xdr: string; fee: string }> {
  const entry = resolveVaultEntry(vaultId, network);
  return buildCoordinatorDepositTx(
    { contractId: entry.contractId, network },
    walletAddress,
    toStroops(amount),
    toStroops(minSharesOut)
  );
}

/**
 * Build an unsigned withdrawal transaction for the coordinator vault identified
 * by `vaultId`. `shares` is the mUSDC share count to burn. `minUsdcOut` is the
 * minimum USDC the caller is willing to receive; the vault rejects the call
 * with `MinAmountOutNotMet` if the redeemed amount falls below it. Defaults to
 * `"0"` (no slippage protection) when omitted.
 */
export async function buildWithdrawTx(
  vaultId: string,
  walletAddress: string,
  shares: string,
  network: StellarNetwork,
  minUsdcOut: string = "0"
): Promise<{ xdr: string; fee: string }> {
  const entry = resolveVaultEntry(vaultId, network);
  return buildCoordinatorWithdrawTx(
    { contractId: entry.contractId, network },
    walletAddress,
    toStroops(shares),
    toStroops(minUsdcOut)
  );
}

/**
 * Fetches all positions for `publicKey` across every registered coordinator
 * vault on the given network. Failures from any single vault are logged and
 * suppressed so partial results are always returned.
 */
export async function resolvePositions(
  publicKey: string,
  network: StellarNetwork
): Promise<PositionInfo[]> {
  const pools = Object.values(
    network.network === "testnet" ? KNOWN_POOLS.testnet : KNOWN_POOLS.mainnet
  ).filter(
    (p): p is typeof p & { contractId: string } =>
      p.protocol === "meridian" && Boolean(p.contractId)
  );

  const results = await Promise.allSettled(
    pools.map((p) =>
      fetchCoordinatorPosition(
        { contractId: p.contractId, network },
        p.id,
        publicKey
      )
    )
  );

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
