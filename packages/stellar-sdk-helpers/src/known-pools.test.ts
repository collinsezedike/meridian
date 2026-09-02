import { describe, expect, it } from "vitest";
import { KNOWN_POOLS } from "./known-pools";

describe("known-pools", () => {
  it("contains valid mainnet pools metadata", () => {
    expect(KNOWN_POOLS.mainnet).toBeDefined();
    const mainnetKeys = Object.keys(KNOWN_POOLS.mainnet);
    expect(mainnetKeys.length).toBeGreaterThan(0);

    for (const key of mainnetKeys) {
      const pool = KNOWN_POOLS.mainnet[key];
      expect(pool.id).toBeTruthy();
      expect(pool.name).toBeTruthy();
      expect(pool.protocol).toBeTruthy();
      expect(pool.label).toBeTruthy();
    }
  });

  it("contains valid testnet pools metadata", () => {
    expect(KNOWN_POOLS.testnet).toBeDefined();
    const testnetKeys = Object.keys(KNOWN_POOLS.testnet);
    expect(testnetKeys.length).toBeGreaterThan(0);

    for (const key of testnetKeys) {
      const pool = KNOWN_POOLS.testnet[key];
      expect(pool.id).toBeTruthy();
      expect(pool.name).toBeTruthy();
      expect(pool.protocol).toBeTruthy();
      expect(pool.label).toBeTruthy();
      expect(pool.contractId).toBeTruthy();
      expect(pool.assetId).toBeTruthy();
      expect(pool.asset).toBeTruthy();
    }
  });
});
