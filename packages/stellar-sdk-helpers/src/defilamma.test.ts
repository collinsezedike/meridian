import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assessPoolRisk,
  getStellarStablecoinPools,
  type DefiLlamaPool,
} from "./defilamma";

function pool(overrides: Partial<DefiLlamaPool> = {}): DefiLlamaPool {
  return {
    pool: "p",
    project: "blend",
    symbol: "USDC",
    tvlUsd: 5_000_000,
    apy: 5,
    apyPct1D: 0,
    apyPct7D: 0,
    apyPct30D: 0,
    poolMeta: null,
    stablecoin: true,
    chain: "Stellar",
    ...overrides,
  };
}

describe("assessPoolRisk", () => {
  it("rates a deep, stable, modest-APY pool as safe", () => {
    expect(
      assessPoolRisk(pool({ tvlUsd: 5_000_000, apyPct7D: 0.5, apy: 5 }))
    ).toBe("safe");
  });

  it("rates thin liquidity as caution", () => {
    expect(assessPoolRisk(pool({ tvlUsd: 50_000, apyPct7D: 0, apy: 5 }))).toBe(
      "caution"
    );
  });

  it("rates tiny TVL with a high, volatile APY as risky", () => {
    expect(assessPoolRisk(pool({ tvlUsd: 5_000, apyPct7D: 40, apy: 25 }))).toBe(
      "risky"
    );
  });
});

describe("getStellarStablecoinPools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps only Stellar stablecoin pools above the TVL/APY floors", async () => {
    const data = [
      pool({
        pool: "keep",
        chain: "Stellar",
        stablecoin: true,
        apy: 5,
        tvlUsd: 1_000_000,
      }),
      pool({ pool: "wrong-chain", chain: "Ethereum" }),
      pool({ pool: "not-stable", stablecoin: false }),
      pool({ pool: "tiny-tvl", tvlUsd: 500 }),
      pool({ pool: "no-apy", apy: 0 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }))
    );
    const result = await getStellarStablecoinPools();
    expect(result.map((p) => p.pool)).toEqual(["keep"]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 }))
    );
    await expect(getStellarStablecoinPools()).rejects.toThrow(/502/);
  });
});
