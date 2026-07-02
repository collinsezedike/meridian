import { Networks, rpc } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

export const BASE_FEE = "100";

export const STROOPS_PER_UNIT = 1e7;

export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (value === null || value === undefined) return 0n;
  throw new TypeError(
    `toBigInt: unexpected type ${typeof value}: ${String(value)}`
  );
}

export function passphraseFor(network: StellarNetwork): string {
  switch (network.network) {
    case "mainnet":
      return Networks.PUBLIC;
    case "testnet":
      return Networks.TESTNET;
    case "futurenet":
      return Networks.FUTURENET;
  }
}

const _rpcServerCache = new Map<string, rpc.Server>();

export function getRpcServer(url: string, timeout: number): rpc.Server {
  const key = `${url}:${timeout}`;
  let server = _rpcServerCache.get(key);
  if (!server) {
    server = new rpc.Server(url, { timeout });
    _rpcServerCache.set(key, server);
  }
  return server;
}
