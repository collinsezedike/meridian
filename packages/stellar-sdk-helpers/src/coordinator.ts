import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { prepareSorobanTx, simulateView } from "./tx";
import { getRpcServer, toBigInt } from "./internal";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";
import { stroopsToUnits } from "./defindex";

export interface CoordinatorConfig {
  contractId: string;
  network: StellarNetwork;
}

function i128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

/**
 * Build an unsigned deposit transaction that calls the coordinator vault's
 * `deposit(caller, amount)` function. The vault forwards USDC to its active
 * adapter, which deploys it to the underlying protocol.
 */
export async function buildCoordinatorDepositTx(
  config: CoordinatorConfig,
  walletAddress: string,
  amount: bigint
): Promise<{ xdr: string; fee: string }> {
  if (amount <= 0n) throw new Error("amount must be positive");
  const contract = new Contract(config.contractId);
  return prepareSorobanTx(
    config.network,
    walletAddress,
    contract.call(
      "deposit",
      Address.fromString(walletAddress).toScVal(),
      i128(amount)
    )
  );
}

/**
 * Build an unsigned withdrawal transaction that calls the coordinator vault's
 * `withdraw(caller, shares)` function. The vault redeems the proportional
 * adapter shares and returns USDC to the caller.
 */
export async function buildCoordinatorWithdrawTx(
  config: CoordinatorConfig,
  walletAddress: string,
  shares: bigint
): Promise<{ xdr: string; fee: string }> {
  if (shares <= 0n) throw new Error("shares must be positive");
  const contract = new Contract(config.contractId);
  return prepareSorobanTx(
    config.network,
    walletAddress,
    contract.call(
      "withdraw",
      Address.fromString(walletAddress).toScVal(),
      i128(shares)
    )
  );
}

/**
 * Read the caller's current position in the coordinator vault via read-only
 * simulation. Returns `[]` when the address holds no shares.
 *
 * `shares` is the mUSDC balance. `deposited` is the live USDC value of those
 * shares (shares * total_assets / total_shares). `earned` is derived from the
 * stored cost basis (current value minus principal).
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

  const totalAssets = toBigInt(totalAssetsRaw);
  const totalShares = toBigInt(totalSharesRaw);
  const principal = toBigInt(principalRaw);
  const entryTime = Number(toBigInt(entryTimeRaw));

  const deposited =
    totalShares > 0n
      ? stroopsToUnits((sharesRaw * totalAssets) / totalShares)
      : 0;
  const principalUnits = stroopsToUnits(principal);
  const earned = Math.max(0, deposited - principalUnits);

  return [
    {
      vaultId,
      shares: stroopsToUnits(sharesRaw),
      deposited,
      earned,
      entryTime,
    },
  ];
}
