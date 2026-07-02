import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { PoolV2 } from "@blend-capital/blend-sdk";
import { fetchAllVaults, clearVaultCache } from "./vaults";

// Mainnet DeFiLlama pool UUID mapping to blend-usdc-fixed in KNOWN_POOLS.mainnet.
const KNOWN_BLEND = "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf";

function llamaPool(overrides: Record<string, unknown> = {}) {
  return {
    pool: KNOWN_BLEND,
    project: "blend",
    symbol: "USDC",
    tvlUsd: 5_000_000,
    apy: 5.123,
    apyPct1D: 0,
    apyPct7D: 0,
    apyPct30D: 0,
    poolMeta: null,
    stablecoin: true,
    chain: "Stellar",
    ...overrides,
  };
}

function stubPools(data: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }))
  );
}

describe("fetchAllVaults", () => {
  beforeEach(() => clearVaultCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearVaultCache();
  });

  it("maps known DeFiLlama pools and rounds APY to two decimals", async () => {
    stubPools([llamaPool()]);
    const vaults = await fetchAllVaults("mainnet");
    expect(vaults).toHaveLength(1);
    expect(vaults[0].id).toBe("blend-usdc-fixed");
    expect(vaults[0].protocol).toBe("blend");
    expect(vaults[0].apy).toBe(5.12);
    expect(vaults[0].riskLevel).toBe("safe");
  });

  it("skips pools with no known-pool mapping", async () => {
    stubPools([llamaPool({ pool: "unrecognised-id" })]);
    expect(await fetchAllVaults("mainnet")).toEqual([]);
  });

  it("no longer emits a placeholder DeFindex vault", async () => {
    stubPools([]);
    const vaults = await fetchAllVaults("mainnet");
    expect(vaults.find((v) => v.protocol === "defindex")).toBeUndefined();
  });

  it("returns cached result and skips DeFiLlama on repeated calls within TTL", async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [llamaPool()] }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchAllVaults("mainnet");
    await fetchAllVaults("mainnet");

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("serves stale cache instead of empty list when DeFiLlama returns no pools", async () => {
    // Prime the cache with a valid vault list.
    stubPools([llamaPool()]);
    const first = await fetchAllVaults("mainnet");
    expect(first).toHaveLength(1);

    // Now simulate a DeFiLlama blip — all pools gone — after TTL expiry.
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    stubPools([]);
    const second = await fetchAllVaults("mainnet");

    // Should return the previous cache, not an empty array.
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("blend-usdc-fixed");
  });

  it("re-fetches from DeFiLlama after the 60 s TTL expires", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [llamaPool()] }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchAllVaults("mainnet");
    vi.advanceTimersByTime(61_000);
    await fetchAllVaults("mainnet");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchAllVaults (testnet)", () => {
  // USDC SAC for Blend TestnetV2 (from KNOWN_POOLS.testnet["blend-testnet-usdc"].assetId).
  const TESTNET_USDC_SAC =
    "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";

  beforeEach(() => clearVaultCache());
  afterEach(() => {
    vi.restoreAllMocks();
    clearVaultCache();
  });

  it("returns testnet vault with TVL and APY derived from on-chain reserve", async () => {
    // 1 000 USDC = 10_000_000_000 stroops (7 decimal places). 5% APY = 0.05.
    vi.spyOn(PoolV2, "load").mockResolvedValue({
      reserves: new Map([
        [
          TESTNET_USDC_SAC,
          { totalSupply: () => 10_000_000_000n, estSupplyApy: 0.05 },
        ],
      ]),
    } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);

    const vaults = await fetchAllVaults("testnet");
    expect(vaults).toHaveLength(1);
    expect(vaults[0].id).toBe("blend-usdc-fixed");
    expect(vaults[0].tvl).toBe(1000);
    expect(vaults[0].apy).toBe(5);
    expect(vaults[0].riskLevel).toBe("safe");
  });

  it("returns zero TVL and zero APY when the reserve is absent from the pool", async () => {
    vi.spyOn(PoolV2, "load").mockResolvedValue({
      reserves: new Map(),
    } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);

    const vaults = await fetchAllVaults("testnet");
    expect(vaults[0].tvl).toBe(0);
    expect(vaults[0].apy).toBe(0);
  });

  it("does not cache testnet results between calls", async () => {
    const loadSpy = vi.spyOn(PoolV2, "load").mockResolvedValue({
      reserves: new Map([
        [TESTNET_USDC_SAC, { totalSupply: () => 0n, estSupplyApy: 0 }],
      ]),
    } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);

    await fetchAllVaults("testnet");
    await fetchAllVaults("testnet");

    expect(loadSpy).toHaveBeenCalledTimes(2);
  });
});
