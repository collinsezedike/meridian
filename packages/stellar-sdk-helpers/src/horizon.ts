import { Horizon } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

/** Construct a Horizon.Server pointed at the correct URL for the given network. */
export function buildHorizonServer(config: StellarNetwork): Horizon.Server {
  const urls: Record<StellarNetwork["network"], string> = {
    mainnet: "https://horizon.stellar.org",
    testnet: "https://horizon-testnet.stellar.org",
    futurenet: "https://horizon-futurenet.stellar.org",
  };
  return new Horizon.Server(urls[config.network]);
}

