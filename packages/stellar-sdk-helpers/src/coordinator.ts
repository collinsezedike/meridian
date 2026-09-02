import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { prepareSorobanTx, simulateView } from "./tx";
import { getRpcServer, toBigInt } from "./internal";
import type { StellarNetwork } from "./types";
import { computePosition, type PositionInfo } from "./positions";

export interface CoordinatorConfig {
  contractId: string;
  network: StellarNetwork;
}

function i128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

/**
 * Build an unsigned deposit transaction that calls the coordinator vault's
 * `deposit(caller, amount, min_shares_out)` function. The vault forwards USDC to its active
 * adapter, which deploys it to the underlying protocol.
 *
 * `minSharesOut` is the slippage guard: the contract rejects the transaction
 * with `SlippageExceeded` if the minted shares would fall below this value.
 * Pass `0n` to disable slippage protection.
 */
export async function buildCoordinatorDepositTx(
  config: CoordinatorConfig,
  walletAddress: string,
  amount: bigint,
  minSharesOut: bigint = 0n
): Promise<{ xdr: string; fee: string }> {
  if (amount <= 0n) throw new Error("amount must be positive");
  if (minSharesOut < 0n) throw new Error("minSharesOut must be non-negative");
  const contract = new Contract(config.contractId);
  return prepareSorobanTx(
    config.network,
    walletAddress,
    contract.call(
      "deposit",
      Address.fromString(walletAddress).toScVal(),
      i128(amount),
      i128(minSharesOut)
    )
  );
}

/**
 * Build an unsigned withdrawal transaction that calls the coordinator vault's
 * `withdraw(caller, shares, min_usdc_out)` function. The vault redeems the
 * proportional adapter shares and returns USDC to the caller.
 *
 * `minUsdcOut` is the slippage guard: the contract rejects the transaction
 * with `MinAmountOutNotMet` if the redeemed USDC would fall below this value.
 * Pass `0n` to disable slippage protection.
 */
export async function buildCoordinatorWithdrawTx(
  config: CoordinatorConfig,
  walletAddress: string,
  shares: bigint,
  minUsdcOut: bigint = 0n
): Promise<{ xdr: string; fee: string }> {
  if (shares <= 0n) throw new Error("shares must be positive");
  if (minUsdcOut < 0n) throw new Error("minUsdcOut must be non-negative");
  const contract = new Contract(config.contractId);
  return prepareSorobanTx(
    config.network,
    walletAddress,
    contract.call(
      "withdraw",
      Address.fromString(walletAddress).toScVal(),
      i128(shares),
      i128(minUsdcOut)
    )
  );
}

/**
 * Read the caller's current position in the coordinator vault via read-only
 * simulation. Returns `[]` when the address holds no shares.
 *
 * `shares` is the mUSDC balance. `deposited` is the live USDC value of those
 * shares (shares * total_assets / total_shares). `earned` is derived from the
 * stored cost basis (current value minus principal) via `computePosition`,
 * which is what guards against a transferred-in holder's zero basis being
 * read as zero cost rather than "no basis recorded" (see its `hasBasis`
 * comment) — a mUSDC transfer-in looks identical here to a genuine deposit
 * with a zero principal, and the two must not be confused.
 */
export async function fetchCoordinatorPosition(
  config: CoordinatorConfig,
  vaultId: string,
  publicKey: string
): Promise<PositionInfo[]> {
  const { contractId, network } = config;
  const server = getRpcServer(network.rpcUrl, 12_000);
  const passphrase = network.passphrase;
  const callerScVal = Address.fromString(publicKey).toScVal();

  const sharesRaw = toBigInt(
    await simulateView(
      server,
      contractId,
      passphrase,
      "get_position",
      callerScVal
    )
  );
  if (sharesRaw <= 0n) return [];

  const [totalAssetsRaw, totalSharesRaw, principalRaw, entryTimeRaw] =
    await Promise.all([
      simulateView(server, contractId, passphrase, "get_total_assets"),
      simulateView(server, contractId, passphrase, "get_total_shares"),
      simulateView(
        server,
        contractId,
        passphrase,
        "get_principal",
        callerScVal
      ),
      simulateView(
        server,
        contractId,
        passphrase,
        "get_entry_time",
        callerScVal
      ),
    ]);

  return computePosition(vaultId, {
    shares: sharesRaw,
    totalShares: toBigInt(totalSharesRaw),
    totalAssets: toBigInt(totalAssetsRaw),
    principal: toBigInt(principalRaw),
    entryTime: toBigInt(entryTimeRaw),
  });
}

/**
 * Read the coordinator vault's current admin address via read-only
 * simulation. Used to gate the admin dashboard: a connected wallet is
 * authorized only if its public key matches this address.
 */
export async function fetchVaultAdmin(
  config: CoordinatorConfig
): Promise<string> {
  const { contractId, network } = config;
  const server = getRpcServer(network.rpcUrl, 12_000);
  const admin = await simulateView(
    server,
    contractId,
    network.passphrase,
    "get_admin"
  );
  if (typeof admin !== "string") {
    throw new Error("get_admin: unexpected response shape");
  }
  return admin;
}

export interface CoordinatorState {
  // The adapter's own reported protocol id (e.g. "blend", "defindex"),
  // discovered on-chain via get_adapter -> get_protocol rather than tracked
  // in config — see fetchMeridianApy in vaults.ts for why that matters: it
  // self-updates if the adapter is ever swapped via set_adapter or
  // migrate_adapter, with nothing that could drift out of sync.
  protocol: string;
  adapterId: string;
  // Human-readable units (USDC/mUSDC, not stroops), rounded to 2 decimals.
  totalShares: number;
  totalAssets: number;
  paused: boolean;
}

/**
 * Reads the coordinator vault's current operational state for the admin
 * dashboard's Vault State card: active adapter/protocol, total shares, total
 * assets, and the pause flag. All four reads are read-only simulations, no
 * signature required.
 */
export async function fetchCoordinatorState(
  config: CoordinatorConfig
): Promise<CoordinatorState> {
  const { contractId, network } = config;
  const server = getRpcServer(network.rpcUrl, 12_000);
  const passphrase = network.passphrase;

  const adapterId = (await simulateView(
    server,
    contractId,
    passphrase,
    "get_adapter"
  )) as string;

  const [protocol, totalSharesRaw, totalAssetsRaw, paused] = await Promise.all([
    simulateView(server, adapterId, passphrase, "get_protocol"),
    simulateView(server, contractId, passphrase, "get_total_shares"),
    simulateView(server, contractId, passphrase, "get_total_assets"),
    simulateView(server, contractId, passphrase, "is_paused"),
  ]);

  return {
    protocol: protocol as string,
    adapterId,
    totalShares: toHumanUnits(toBigInt(totalSharesRaw)),
    totalAssets: toHumanUnits(toBigInt(totalAssetsRaw)),
    paused: Boolean(paused),
  };
}

function toHumanUnits(stroops: bigint): number {
  return Number((Number(stroops) / 1e7).toFixed(2));
}
