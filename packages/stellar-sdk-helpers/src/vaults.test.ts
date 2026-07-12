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

vi.mock("./tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tx")>();
  return { ...actual, simulateView: vi.fn() };
});

vi.mock("./internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./internal")>();
  return {
    ...actual,
    getRpcServer: vi.fn(() => ({})),
    toBigInt: vi.fn((v: unknown) => v as bigint),
  };
});

import { simulateView } from "./tx";
import { toBigInt } from "./internal";

const ADAPTER_ID = "CADAPTER00000000000000000000000000000000000000000000000000";
const POOL_ID = "CPOOL0000000000000000000000000000000000000000000000000000";

// Mocks simulateView's `method` param (5th positional arg after server,
// contractId, passphrase, method) so different on-chain calls can return
// different values, matching how fetchMeridianApy actually calls it.
function mockAdapterDiscovery(opts: {
  totalAssets?: bigint;
  protocol?: string;
}) {
  vi.mocked(simulateView).mockImplementation(
    async (_server, _contractId, _passphrase, method) => {
      switch (method) {
        case "get_total_assets":
          return (opts.totalAssets ?? 0n) as never;
        case "get_adapter":
          return ADAPTER_ID as never;
        case "get_pool":
          return POOL_ID as never;
        case "get_protocol":
          return (opts.protocol ?? "blend") as never;
        default:
          throw new Error(`unexpected simulateView method: ${String(method)}`);
      }
    }
  );
}

describe("fetchAllVaults (testnet)", () => {
  beforeEach(() => {
    clearVaultCache();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearVaultCache();
  });

  it("returns meridian vault with TVL derived from get_total_assets", async () => {
    // 1 000 USDC = 10_000_000_000 stroops (7 decimal places).
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(10_000_000_000n);

    const vaults = await fetchAllVaults("testnet");
    expect(vaults).toHaveLength(1);
    expect(vaults[0].id).toBe("meridian-usdc");
    expect(vaults[0].protocol).toBe("meridian");
    expect(vaults[0].tvl).toBe(1000);
    expect(vaults[0].riskLevel).toBe("safe");
  });

  it("returns zero TVL when get_total_assets returns zero", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(0n);

    const vaults = await fetchAllVaults("testnet");
    expect(vaults[0].tvl).toBe(0);
  });

  it("does not cache testnet results between calls", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(0n);

    await fetchAllVaults("testnet");
    await fetchAllVaults("testnet");

    const totalAssetsCalls = vi
      .mocked(simulateView)
      .mock.calls.filter(([, , , method]) => method === "get_total_assets");
    expect(totalAssetsCalls).toHaveLength(2);
  });

  it("fetches live Blend APY when the active adapter wraps a Blend pool", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "blend" });
    vi.mocked(toBigInt).mockReturnValue(0n);
    const usdcAssetId =
      "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
    const loadSpy = vi.spyOn(PoolV2, "load").mockResolvedValue({
      reserves: new Map([
        [usdcAssetId, { totalSupply: () => 0n, estSupplyApy: 0.08 }],
      ]),
    } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);

    const vaults = await fetchAllVaults("testnet");

    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: expect.any(String) }),
      POOL_ID
    );
    expect(vaults[0].apy).toBe(8);
  });

  it("returns apy 0 without querying Blend when the adapter wraps an unrecognised protocol", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "defindex" });
    vi.mocked(toBigInt).mockReturnValue(0n);
    const loadSpy = vi.spyOn(PoolV2, "load");

    const vaults = await fetchAllVaults("testnet");

    expect(vaults[0].apy).toBe(0);
    expect(loadSpy).not.toHaveBeenCalled();
  });
});
