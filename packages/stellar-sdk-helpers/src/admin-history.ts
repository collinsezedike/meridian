import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

/* ───────────────────────────────────────────────────────────────────────────
 * Horizon-based admin history (issue #616)
 * Reads past admin actions by scanning Horizon `invoke_host_function`
 * operations. This is the data source confirmed in the upstream codebase and
 * is covered by admin-history.test.ts.
 * ──────────────────────────────────────────────────────────────────────── */

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

/* ───────────────────────────────────────────────────────────────────────────
 * RPC getEvents admin history (issue #697)
 * Reads vault admin actions from Soroban RPC `getEvents` — filtering
 * server-side by contract ID and the `admin` topic emitted by the vault
 * contract. This scales to mainnet because the RPC filters on the server.
 * Types are prefixed with `Rpc` to avoid colliding with the Horizon types
 * above.
 * ──────────────────────────────────────────────────────────────────────── */

export type RpcAdminActionType =
  "paused" | "transfer" | "accept" | "adapter" | "migrate";

export interface RpcAdminAction {
  /** The kind of admin action recorded on-chain. */
  action: RpcAdminActionType;
  /** Ledger sequence at which the event was emitted. */
  ledgerSequence: number;
  /** Approximate wall-clock time if the RPC response includes it. */
  timestamp?: Date;
  /** Topic-parsed payload. */
  payload: RpcAdminActionPayload;
}

export type RpcAdminActionPayload =
  | { paused: boolean }
  | { newAdmin: string }
  | { newAdapter: string }
  | { oldAdapter: string; newAdapter: string };

export interface RpcAdminHistoryOptions {
  /** First ledger to scan. Defaults to 0 (genesis). Ignored when `cursor` is set. */
  startLedger?: number;
  /** Maximum events to fetch in one request. Defaults to 200. */
  limit?: number;
  /** Cursor for pagination. Mutually exclusive with `startLedger`. */
  cursor?: string;
}

/**
 * Base64 XDR of `ScVal::Symbol("admin")`, the top-level topic the vault
 * attaches to every admin-action event.
 *
 * Derived from the SDK at module load rather than hardcoded so the wire
 * encoding can never drift from the library that decodes it:
 * `xdr.ScVal.scvSymbol("admin").toXDR("base64") === "AAAADwAAAAVhZG1pbgAAAA=="`.
 */
const ADMIN_TOPIC_XDR: string = xdr.ScVal.scvSymbol("admin").toXDR("base64");

/**
 * Reads vault admin actions from RPC `getEvents` instead of paging through
 * Horizon's global invocation history.
 *
 * Filters to the vault contract and the top-level `admin` topic, then
 * parses each event into a typed {@link RpcAdminAction}. This scales to mainnet
 * because the RPC filters server-side by contract ID and topic.
 */
export async function getRpcAdminHistory(
  rpcUrl: string,
  vaultContractId: string,
  options: RpcAdminHistoryOptions = {}
): Promise<{ actions: RpcAdminAction[]; nextCursor?: string }> {
  const server = new rpc.Server(rpcUrl);
  const limit = options.limit ?? 200;

  // Soroban RPC's getEvents topic filter matches an event's topic array by
  // exact segment count; a shorter filter does not match a longer one. The
  // vault's admin events all carry two segments — (admin, <action>) — so the
  // filter needs a second, wildcarded position to match them at all.
  const filters: rpc.Api.EventFilter[] = [
    {
      type: "contract",
      contractIds: [vaultContractId],
      topics: [[ADMIN_TOPIC_XDR, "*"]],
    },
  ];

  // `GetEventsRequest` is a discriminated union: a request is either a ledger
  // range or a cursor continuation, never both.
  const response = options.cursor
    ? await server.getEvents({ filters, cursor: options.cursor, limit })
    : await server.getEvents({
        filters,
        startLedger: options.startLedger ?? 0,
        limit,
      });

  const actions: RpcAdminAction[] = [];
  for (const event of response.events ?? []) {
    const parsed = parseAdminEvent(event);
    if (parsed) actions.push(parsed);
  }

  return { actions, nextCursor: response.cursor };
}

/**
 * Converts one RPC event into an {@link RpcAdminAction}, or `null` when the
 * event is not a recognised admin action.
 *
 * The vault emits `(admin, <action>)` topics, so `topic[0]` is the constant
 * `admin` symbol and `topic[1]` carries the action. The event value is already
 * a decoded `xdr.ScVal`, so no base64 round-trip is needed.
 */
function parseAdminEvent(event: rpc.Api.EventResponse): RpcAdminAction | null {
  const action = parseTopicAction(event.topic[1]);
  if (!action) return null;

  // `timestamp` is spread conditionally: with `exactOptionalPropertyTypes` an
  // optional property may not be assigned an explicit `undefined`.
  const base: Omit<RpcAdminAction, "payload"> = {
    action,
    ledgerSequence: event.ledger,
    ...(event.ledgerClosedAt
      ? { timestamp: new Date(event.ledgerClosedAt) }
      : {}),
  };

  const value = event.value;
  switch (action) {
    case "paused": {
      if (value.switch().name !== "scvBool") return null;
      return { ...base, payload: { paused: value.b() } };
    }
    case "transfer":
    case "accept": {
      const newAdmin = parseScValAddress(value);
      return newAdmin ? { ...base, payload: { newAdmin } } : null;
    }
    case "adapter": {
      const newAdapter = parseScValAddress(value);
      return newAdapter ? { ...base, payload: { newAdapter } } : null;
    }
    case "migrate": {
      // The value is a two-element vec: (old_adapter, new_adapter).
      if (value.switch().name !== "scvVec") return null;
      const items = value.vec();
      if (!items || items.length < 2) return null;
      const oldAdapter = parseScValAddress(items[0]!);
      const newAdapter = parseScValAddress(items[1]!);
      if (!oldAdapter || !newAdapter) return null;
      return { ...base, payload: { oldAdapter, newAdapter } };
    }
  }
}

/**
 * Reads the action symbol out of `topic[1]`. Accessing a mismatched arm on an
 * `xdr.ScVal` throws, so the switch is checked before reading.
 */
function parseTopicAction(
  topic: xdr.ScVal | undefined
): RpcAdminActionType | null {
  if (!topic || topic.switch().name !== "scvSymbol") return null;

  const symbol = topic.sym().toString();
  switch (symbol) {
    case "paused":
    case "transfer":
    case "accept":
    case "adapter":
    case "migrate":
      return symbol;
    default:
      return null;
  }
}

/**
 * Decodes an `ScVal` holding a contract or account `Address` into its strkey
 * form. Mirrors the `Address.fromScVal` decoding used by {@link decodeScVal}.
 */
function parseScValAddress(val: xdr.ScVal): string | null {
  if (val.switch().name !== "scvAddress") return null;
  try {
    return Address.fromScVal(val).toString();
  } catch {
    return null;
  }
}
