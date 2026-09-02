import { Address, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

export interface AdminAction {
  id: string;
  type: AdminActionType;
  timestamp: string;
  transactionHash: string;
  sourceAccount: string;
  summary: string;
  details: Record<string, unknown>;
}

export type AdminActionType =
  | "set_admin"
  | "set_paused"
  | "set_adapter"
  | "migrate_adapter"
  | "begin_migration"
  | "transfer_admin"
  | "accept_admin";

const ADMIN_FUNCTIONS = new Set<AdminActionType>([
  "set_admin",
  "set_paused",
  "set_adapter",
  "migrate_adapter",
  "begin_migration",
  "transfer_admin",
  "accept_admin",
]);

function buildHorizonServer(network: StellarNetwork["network"]): {
  baseUrl: string;
} {
  const urls: Record<StellarNetwork["network"], string> = {
    mainnet: "https://horizon.stellar.org",
    testnet: "https://horizon-testnet.stellar.org",
    futurenet: "https://horizon-futurenet.stellar.org",
  };
  return { baseUrl: urls[network] };
}

export function decodeScVal(
  base64: string
): { switchName: string; value: unknown } | null {
  try {
    const scVal = xdr.ScVal.fromXDR(base64, "base64");
    const switchName = scVal.switch().name;
    switch (switchName) {
      case "scvAddress":
        return { switchName, value: Address.fromScVal(scVal).toString() };
      case "scvSymbol":
        return { switchName, value: scVal.sym().toString() };
      case "scvU64":
        return { switchName, value: scVal.u64().toString() };
      case "scvBool":
        return { switchName, value: scVal.b() };
      case "scvString":
        return { switchName, value: scVal.str().toString() };
      default:
        return { switchName, value: null };
    }
  } catch {
    return null;
  }
}

export function summarizeAction(
  type: AdminActionType,
  params: Array<{ type: string; value: unknown }>
): string {
  switch (type) {
    case "set_admin": {
      const newAdmin = params[2]?.value;
      return typeof newAdmin === "string"
        ? `New admin set to ${newAdmin.slice(0, 8)}...${newAdmin.slice(-4)}`
        : "Admin address changed";
    }
    case "set_paused": {
      const paused = params[2]?.value;
      return typeof paused === "boolean"
        ? paused
          ? "Vault deposits paused"
          : "Vault deposits unpaused"
        : "Pause state toggled";
    }
    case "set_adapter": {
      const adapter = params[2]?.value;
      return typeof adapter === "string"
        ? `Adapter switched to ${adapter.slice(0, 8)}...${adapter.slice(-4)}`
        : "Adapter updated";
    }
    case "migrate_adapter": {
      const adapter = params[2]?.value;
      return typeof adapter === "string"
        ? `Migrated adapter to ${adapter.slice(0, 8)}...${adapter.slice(-4)}`
        : "Adapter migrated";
    }
    case "begin_migration": {
      const adapter = params[2]?.value;
      return typeof adapter === "string"
        ? `Migration cooldown started for ${adapter.slice(0, 8)}...${adapter.slice(-4)}`
        : "Migration cooldown started";
    }
    case "transfer_admin": {
      const nominee = params[2]?.value;
      return typeof nominee === "string"
        ? `Admin transfer nominated ${nominee.slice(0, 8)}...${nominee.slice(-4)}`
        : "Admin transfer initiated";
    }
    case "accept_admin": {
      return "Admin transfer accepted";
    }
  }
}

/**
 * Reads past admin actions for a vault contract by scanning Horizon
 * `invoke_host_function` operations. Each Soroban contract invocation records
 * the target contract address (parameters[0]) and function name (parameters[1])
 * as base64-encoded `ScVal` values, so we can filter client-side without any
 * contract-side event emission.
 *
 * This is the data source confirmed for issue #616: Horizon operations provide
 * a complete, queryable history of every `set_admin`, `set_paused`,
 * `set_adapter`, `migrate_adapter`, `transfer_admin`, and `accept_admin`
 * call made against the vault.
 */
export interface GetAdminActionHistoryOptions {
  limit?: number;
  maxPages?: number;
}

export async function getAdminActionHistory(
  network: StellarNetwork,
  vaultContractId: string,
  options: GetAdminActionHistoryOptions = {}
): Promise<AdminAction[]> {
  const { limit = 50, maxPages = 20 } = options;
  const { baseUrl } = buildHorizonServer(network.network);
  const actions: AdminAction[] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (actions.length < limit && pages < maxPages) {
    const url = new URL("/operations", baseUrl);
    url.searchParams.set("type", "invoke_host_function");
    url.searchParams.set("order", "desc");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Horizon operations request failed: ${response.status}`);
    }
    const data = (await response.json()) as {
      _embedded: {
        records: Array<{
          id: string;
          paging_token: string;
          type: string;
          transaction_hash: string;
          created_at: string;
          source_account: string;
          parameters?: Array<{ type: string; value: string }>;
        }>;
      };
      _links: { next?: { href: string } };
    };

    const records = data._embedded?.records ?? [];
    for (const record of records) {
      if (actions.length >= limit) break;

      const params = record.parameters ?? [];
      if (params.length < 2) continue;

      const contractParam = decodeScVal(params[0]!.value);
      const functionParam = decodeScVal(params[1]!.value);

      if (
        contractParam?.switchName === "scvAddress" &&
        functionParam?.switchName === "scvSymbol"
      ) {
        const contractId = contractParam.value as string;
        const functionName = functionParam.value as string;

        if (
          contractId.toLowerCase() === vaultContractId.toLowerCase() &&
          ADMIN_FUNCTIONS.has(functionName as AdminActionType)
        ) {
          const decodedParams = params.map((p) => {
            const decoded = decodeScVal(p.value);
            return { type: p.type, value: decoded?.value ?? p.value };
          });

          actions.push({
            id: record.id,
            type: functionName as AdminActionType,
            timestamp: record.created_at,
            transactionHash: record.transaction_hash,
            sourceAccount: record.source_account,
            summary: summarizeAction(
              functionName as AdminActionType,
              decodedParams
            ),
            details: {
              contractId,
              functionName,
              parameters: decodedParams,
            },
          });
        }
      }
    }

    pages++;
    const nextLink = data._links?.next?.href;
    if (!nextLink) break;
    const nextUrl = new URL(nextLink, baseUrl);
    cursor = nextUrl.searchParams.get("cursor") ?? undefined;
  }

  return actions;
}
