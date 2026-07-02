import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { simulateView, prepareSorobanTx } from "./tx";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";
import { toBigInt, STROOPS_PER_UNIT, getRpcServer } from "./internal";

// Converts a stroop-denominated bigint to a floating-point unit value without
// precision loss: the whole-unit part stays in bigint space until it fits
// safely in a Number, then the sub-unit remainder is added as a fraction.
export function stroopsToUnits(stroops: bigint): number {
  const s = BigInt(STROOPS_PER_UNIT);
  return Number(stroops / s) + Number(stroops % s) / STROOPS_PER_UNIT;
}

export interface DefindexVaultConfig {
  // DeFindex vault contract (C...) the request targets.
  vaultId: string;
  network: StellarNetwork;
}

function i128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

/**
 * Build an unsigned transaction that deposits `amount` (in stroops) of the
 * vault's single underlying asset into a DeFindex vault on behalf of `depositor`,
 * auto-investing into the vault's strategies. The user signs and submits the
 * returned XDR and holds the resulting dfToken shares directly — non-custodial.
 *
 * Contract ABI: deposit(amounts_desired: Vec<i128>, amounts_min: Vec<i128>,
 * from: Address, invest: bool). Single-asset vault, so each Vec has one element.
 *
 * `slippageBps` (default 10 = 0.1%) controls the gap between amounts_desired
 * and amounts_min so minor share-price rounding between simulation and submission
 * does not revert the transaction. Pass 0 only in tests.
 */
export async function buildDefindexDepositTx(
  config: DefindexVaultConfig,
  depositor: string,
  amount: bigint,
  slippageBps = 10n
): Promise<{ xdr: string; fee: string }> {
  if (amount <= 0n) throw new Error("amount must be positive");
  const minAmount = amount - (amount * slippageBps) / 10_000n;
  const contract = new Contract(config.vaultId);
  return prepareSorobanTx(
    config.network,
    depositor,
    contract.call(
      "deposit",
      xdr.ScVal.scvVec([i128(amount)]),
      xdr.ScVal.scvVec([i128(minAmount)]),
      Address.fromString(depositor).toScVal(),
      xdr.ScVal.scvBool(true)
    )
  );
}

/**
 * Build an unsigned transaction that burns `shares` (dfTokens, in stroops) to
 * withdraw the proportional underlying back to `withdrawer`.
 *
 * Contract ABI: withdraw(withdraw_shares: i128, min_amounts_out: Vec<i128>,
 * from: Address). min_amounts_out is [0] — slippage protection is deferred to a
 * later pass that quotes the expected out amount.
 */
export async function buildDefindexWithdrawTx(
  config: DefindexVaultConfig,
  withdrawer: string,
  shares: bigint
): Promise<{ xdr: string; fee: string }> {
  if (shares <= 0n) throw new Error("shares must be positive");
  const contract = new Contract(config.vaultId);
  return prepareSorobanTx(
    config.network,
    withdrawer,
    contract.call(
      "withdraw",
      i128(shares),
      xdr.ScVal.scvVec([i128(0n)]),
      Address.fromString(withdrawer).toScVal()
    )
  );
}

/**
 * Read a user's live position in a DeFindex vault via read-only simulation.
 * `balance` gives the dfToken share count; `get_asset_amounts_per_shares` values
 * those shares in the underlying asset. Returns `[]` when the user holds nothing.
 *
 * `shares` carries the dfToken count (not the USD value) because a DeFindex
 * withdrawal burns shares — so the UI's "withdraw max" maps straight to it.
 * `earned` is 0: a direct vault position has no on-chain cost basis (same as the
 * Blend path).
 */
export async function fetchDefindexPosition(
  network: StellarNetwork,
  vaultId: string,
  reportVaultId: string,
  publicKey: string
): Promise<PositionInfo[]> {
  const server = getRpcServer(network.rpcUrl, 12_000);
  const caller = Address.fromString(publicKey).toScVal();

  const shares = toBigInt(
    await simulateView(server, vaultId, network.passphrase, "balance", caller)
  );
  if (shares <= 0n) return [];

  const amounts = (await simulateView(
    server,
    vaultId,
    network.passphrase,
    "get_asset_amounts_per_shares",
    i128(shares)
  )) as Array<bigint | number> | null;
  const underlying =
    Array.isArray(amounts) && amounts.length > 0 ? toBigInt(amounts[0]) : 0n;

  return [
    {
      vaultId: reportVaultId,
      shares: stroopsToUnits(shares),
      deposited: stroopsToUnits(underlying),
      earned: 0,
      entryTime: 0,
    },
  ];
}
