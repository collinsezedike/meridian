import { describe, it, expect } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import { buildHorizonServer } from "./horizon";
import type { StellarNetwork } from "./types";

function network(name: StellarNetwork["network"]): StellarNetwork {
  return { network: name, rpcUrl: "", passphrase: "" };
}

describe("buildHorizonServer", () => {
  it("returns a Horizon.Server instance for every supported network", () => {
    expect(buildHorizonServer(network("testnet"))).toBeInstanceOf(
      Horizon.Server
    );
    expect(buildHorizonServer(network("mainnet"))).toBeInstanceOf(
      Horizon.Server
    );
    expect(buildHorizonServer(network("futurenet"))).toBeInstanceOf(
      Horizon.Server
    );
  });

  it("maps each network to its canonical Horizon endpoint", () => {
    // serverURL.toString() normalises with a trailing slash.
    expect(buildHorizonServer(network("testnet")).serverURL.toString()).toBe(
      "https://horizon-testnet.stellar.org/"
    );
    expect(buildHorizonServer(network("mainnet")).serverURL.toString()).toBe(
      "https://horizon.stellar.org/"
    );
    expect(buildHorizonServer(network("futurenet")).serverURL.toString()).toBe(
      "https://horizon-futurenet.stellar.org/"
    );
  });
});
