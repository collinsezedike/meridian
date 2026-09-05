import type { RouteResult } from "./types";
import { getAdminActionHistory } from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK } from "@meridian/shared";
import { KNOWN_POOLS } from "@meridian/stellar-sdk-helpers";

export async function handleGetAdminHistory(
  vaultId: string
): Promise<RouteResult> {
  try {
    const vault = KNOWN_POOLS.mainnet[vaultId] ?? KNOWN_POOLS.testnet[vaultId];
    if (!vault?.contractId) {
      return {
        status: 404,
        body: { error: "vault not found or missing contractId", vaultId },
      };
    }

    const actions = await getAdminActionHistory(APP_NETWORK, vault.contractId, {
      limit: 50,
      maxPages: 20,
    });

    return {
      status: 200,
      body: {
        vaultId,
        contractId: vault.contractId,
        actions,
        updatedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: "Failed to fetch admin history" },
      error: err,
    };
  }
}
