import type { ApiVault } from "./vaults";

export interface RouteOptions {
  // DeFindex vaults are only routable once a real vault contract is configured.
  defindexConfigured: boolean;
}

// A vault is routable only if Meridian can build a deposit for its protocol.
// Blend is always supported; DeFindex once a vault contract is configured.
function isRoutable(vault: ApiVault, opts: RouteOptions): boolean {
  if (vault.protocol === "blend") return true;
  if (vault.protocol === "defindex") return opts.defindexConfigured;
  return false;
}

/**
 * Pick the vault to route a new deposit into: the highest-APY vault Meridian can
 * actually build a deposit for, preferring pools not flagged "risky". Falls back
 * to the best routable pool when every option is risky, and returns null when
 * nothing is routable. Pure — no I/O.
 */
export function selectBestVault(
  vaults: ApiVault[],
  opts: RouteOptions
): ApiVault | null {
  const routable = vaults.filter((v) => isRoutable(v, opts));
  if (routable.length === 0) return null;

  const safe = routable.filter((v) => v.riskLevel !== "risky");
  const candidates = safe.length > 0 ? safe : routable;

  // Tie-break by id (alphabetical) so the result is stable across requests.
  return candidates.reduce((best, v) =>
    v.apy > best.apy || (v.apy === best.apy && v.id < best.id) ? v : best
  );
}
