import { xdr } from "@stellar/stellar-sdk";
import { PoolContractV2, PoolV2, RequestType } from "@blend-capital/blend-sdk";
import { withRetry } from "@meridian/shared";
import { prepareSorobanTx } from "./tx";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";

const BLEND_RPC_TIMEOUT_MS = 10_000;

// The Blend SDK does not accept an AbortSignal, so we race the call against a
// manual timeout rejection. The underlying fetch will still complete, but the
// caller gets a fast failure it can retry rather than waiting for Vercel's
// function-level deadline.
function withTimeout<T>(fn: () => Promise<T>, ms = BLEND_RPC_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Blend RPC timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export interface BlendPoolConfig {
  // Blend pool contract (C...) the request is submitted to.
  poolId: string;
  // Reserve asset contract — the USDC/EURC Stellar Asset Contract being moved.
  assetId: string;
  network: StellarNetwork;
}

/**
 * Map a Meridian vault ID (e.g. "blend-usdc-fixed") to the reserve asset whose
 * Stellar Asset Contract the deposit supplies. Pure function, no I/O.
 */
export function blendAssetForVault(vaultId: string): "usdc" | "eurc" {
  if (vaultId.includes("-usdc")) return "usdc";
  if (vaultId.includes("-eurc")) return "eurc";
  throw new Error(`No Blend reserve asset mapped for vault: ${vaultId}`);
}

async function buildPoolRequestTx(
  config: BlendPoolConfig,
  caller: string,
  requestType: RequestType,
  amount: bigint
): Promise<{ xdr: string; fee: string }> {
  if (amount <= 0n) throw new Error("amount must be positive");

  // PoolContractV2.submit returns a base64 Soroban operation; we wrap it in a
  // transaction, simulate to obtain the resource footprint + fee, then assemble.
  const pool = new PoolContractV2(config.poolId);
  const opXdr = pool.submit({
    from: caller,
    spender: caller,
    to: caller,
    requests: [{ request_type: requestType, address: config.assetId, amount }],
  });
  const op = xdr.Operation.fromXDR(opXdr, "base64");
  return prepareSorobanTx(config.network, caller, op);
}

/**
 * Build an unsigned transaction that supplies `amount` (in stroops) of the
 * pool's reserve asset into a Blend pool as collateral on behalf of `depositor`.
 *
 * Non-custodial: the user's wallet signs the returned XDR and the frontend
 * submits it. The resulting bToken position is held by the user directly —
 * funds never pass through a Meridian-controlled contract. A missing USDC/EURC
 * trustline or balance surfaces as a simulation error.
 */
export function buildBlendDepositTx(
  config: BlendPoolConfig,
  depositor: string,
  amount: bigint
): Promise<{ xdr: string; fee: string }> {
  return buildPoolRequestTx(config, depositor, RequestType.SupplyCollateral, amount);
}

/**
 * Build an unsigned transaction that withdraws `amount` (in stroops) of supplied
 * collateral back to `withdrawer`. Mirrors the deposit path; the user signs and
 * submits the returned XDR.
 */
export function buildBlendWithdrawTx(
  config: BlendPoolConfig,
  withdrawer: string,
  amount: bigint
): Promise<{ xdr: string; fee: string }> {
  return buildPoolRequestTx(config, withdrawer, RequestType.WithdrawCollateral, amount);
}

export interface BlendReserveRef {
  // Reserve asset contract (the USDC/EURC Stellar Asset Contract).
  assetId: string;
  // Meridian vault id the resulting position is reported under.
  vaultId: string;
}

/**
 * Read a user's live supply position in a Blend pool, one entry per reserve the
 * user holds. The pool ledger state is loaded once and each reserve is valued
 * via the SDK in underlying asset units.
 *
 * `shares` is the collateral-only balance because Meridian withdrawals use
 * RequestType.WithdrawCollateral; including plain-supply in `shares` would cause
 * the withdraw-max flow to submit an amount the pool contract would reject.
 * `deposited` is the full balance (collateral + plain supply) for display.
 * `earned` is 0 -- a direct Blend supply has no on-chain cost basis.
 */
export async function fetchBlendPositions(
  network: StellarNetwork,
  poolId: string,
  publicKey: string,
  reserves: BlendReserveRef[]
): Promise<PositionInfo[]> {
  const pool = await withRetry(() =>
    withTimeout(() => PoolV2.load({ rpc: network.rpcUrl, passphrase: network.passphrase }, poolId))
  );
  const user = await withRetry(() => withTimeout(() => pool.loadUser(publicKey)));

  const positions: PositionInfo[] = [];
  for (const { assetId, vaultId } of reserves) {
    const reserve = pool.reserves.get(assetId);
    if (!reserve) continue;
    const collateral = user.getCollateralFloat(reserve);
    const total = collateral + user.getSupplyFloat(reserve);
    if (total <= 0) continue;
    positions.push({ vaultId, shares: collateral, deposited: total, earned: 0, entryTime: 0 });
  }
  return positions;
}
