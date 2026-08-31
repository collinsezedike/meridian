import { stroopsToUnits } from "./defindex";

export interface PositionInfo {
  vaultId: string;
  shares: number;
  deposited: number;
  earned: number;
  entryTime: number;
}

// Raw i128/u64 figures read from the vault contract, in stroops (7 decimals).
export interface RawPosition {
  shares: bigint;
  totalShares: bigint;
  totalAssets: bigint;
  // Cost basis from get_principal. null when the deployed contract predates
  // principal tracking — earned then falls back to 0 rather than guessing.
  // Zero alongside a positive share balance means the same thing: the vault
  // has no basis recorded for this holder, which is the state of a position
  // that arrived by mUSDC transfer (see the vault contract's
  // `get_principal`). A depositor always has a positive basis while holding
  // shares, so the two cases can't be confused.
  principal: bigint | null;
  entryTime: bigint;
}

/**
 * Derive the display position from raw on-chain figures. Pure and total — no
 * I/O — so the share-value and earned math is unit-testable in isolation.
 *
 *   currentValue = shares * totalAssets / totalShares   (value of the holding)
 *   earned       = max(0, currentValue − principal)     (yield accrued)
 *
 * Returns an empty array when the address holds no shares.
 */
export function computePosition(
  vaultId: string,
  raw: RawPosition
): PositionInfo[] {
  if (raw.shares <= 0n) return [];

  const currentValue =
    raw.totalShares > 0n
      ? (raw.shares * raw.totalAssets) / raw.totalShares
      : 0n;

  // A holder with no recorded basis reports no yield, rather than counting
  // the whole position as profit: mUSDC that arrived by transfer carries no
  // cost basis with it, and treating a missing basis as a basis of zero
  // would show the new holder their entire balance as earnings.
  const hasBasis = raw.principal !== null && raw.principal > 0n;
  const earned =
    hasBasis && currentValue > raw.principal!
      ? currentValue - raw.principal!
      : 0n;

  return [
    {
      vaultId,
      shares: stroopsToUnits(raw.shares),
      deposited: stroopsToUnits(currentValue),
      earned: stroopsToUnits(earned),
      entryTime: Number(raw.entryTime),
    },
  ];
}
