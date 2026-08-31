import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PoolV2,
  ReserveConfigV2,
  ReserveData,
  ReserveV2,
  type Pool,
} from "@blend-capital/blend-sdk";
import { CONTRACT_ADDRESSES } from "@meridian/shared";
import type { StellarNetwork } from "./types";
import type { RateQuery } from "./migration-keeper";

vi.mock("./tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tx")>();
  return { ...actual, simulateView: vi.fn() };
});

import { simulateView } from "./tx";
import {
  createBlendRateSource,
  createDefindexRateSource,
  createDefaultRateSource,
  createInMemoryRateSnapshotStore,
  createUpstashRateSnapshotStore,
  type RateSnapshotStore,
} from "./rate-sources";

const simulateViewMock = vi.mocked(simulateView);

const NETWORK: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://rpc.example",
  passphrase: "Test SDF Network ; September 2015",
};

const BLEND_POOL = "CBLENDPOOL";
const DEFINDEX_VAULT = "CDEFINDEXVAULT";
const ASSET_ID = "CUSDCASSET";
const EURC_ID = "CEURCASSET";

function blendQuery(overrides: Partial<RateQuery> = {}): RateQuery {
  return {
    protocol: "blend",
    adapterId: "CBLENDADAPTER",
    poolId: BLEND_POOL,
    ...overrides,
  };
}

function defindexQuery(overrides: Partial<RateQuery> = {}): RateQuery {
  return {
    protocol: "defindex",
    adapterId: "CDEFINDEXADAPTER",
    poolId: DEFINDEX_VAULT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Blend
// ---------------------------------------------------------------------------

describe("createBlendRateSource", () => {
  it("returns null and never loads the pool for a non-blend query", async () => {
    const loadPool = vi.fn();
    const rateSource = createBlendRateSource({ network: NETWORK, loadPool });

    const rate = await rateSource(defindexQuery());

    expect(rate).toBeNull();
    expect(loadPool).not.toHaveBeenCalled();
  });

  it("returns null when the reserve asset isn't present in the pool", async () => {
    const loadPool = vi.fn(
      async () => ({ reserves: new Map() }) as unknown as Pool
    );
    const rateSource = createBlendRateSource({
      network: NETWORK,
      assetId: ASSET_ID,
      loadPool,
    });

    const rate = await rateSource(blendQuery());

    expect(rate).toBeNull();
    expect(loadPool).toHaveBeenCalledWith(NETWORK, BLEND_POOL);
  });

  it("converts the reserve's estSupplyApy to basis points using the reserve's own computed value", async () => {
    // The "known input/output" here is the Reserve itself (built with real
    // ReserveConfigV2/ReserveData fixtures and blend-sdk's own setRates()
    // below), not a hand-typed magic number: this test is about proving the
    // wrapper (protocol dispatch, asset lookup, *10000 + rounding) is wired
    // correctly, not re-deriving the curve math again (see the dedicated
    // cross-check test below for that).
    const reserve = makeReserveV2({
      rBase: 0.01,
      rOne: 0.04,
      rTwo: 0.5,
      rThree: 1.5,
      util: 0.8,
      curUtil: 0.7,
    });
    reserve.setRates(1_000_000n); // 10% backstop take rate
    expect(reserve.estSupplyApy).toBeGreaterThan(0);

    const loadPool = vi.fn(
      async () =>
        ({ reserves: new Map([[ASSET_ID, reserve]]) }) as unknown as Pool
    );
    const rateSource = createBlendRateSource({
      network: NETWORK,
      assetId: ASSET_ID,
      loadPool,
    });

    const rate = await rateSource(blendQuery());

    expect(rate).toBe(Math.round(reserve.estSupplyApy * 10_000));
  });

  it("defaults assetId from the given network's own USDC address, not a fixed constant", async () => {
    // Regression for PR #538 review: assetId used to default from the
    // process-wide APP_ADDRESSES singleton regardless of the `network` this
    // function actually received. A mainnet call must resolve mainnet's USDC
    // SAC, not whatever process.env.STELLAR_NETWORK happens to be.
    const mainnetReserve = makeReserveV2({
      rBase: 0.01,
      rOne: 0.04,
      rTwo: 0.5,
      rThree: 1.5,
      util: 0.8,
      curUtil: 0.7,
    });
    mainnetReserve.setRates(1_000_000n);
    const loadPool = vi.fn(
      async () =>
        ({
          reserves: new Map([
            [CONTRACT_ADDRESSES.mainnet.usdc, mainnetReserve],
          ]),
        }) as unknown as Pool
    );
    const mainnetNetwork: StellarNetwork = { ...NETWORK, network: "mainnet" };
    const rateSource = createBlendRateSource({
      network: mainnetNetwork,
      loadPool,
    });

    const rate = await rateSource(blendQuery());

    expect(rate).toBe(Math.round(mainnetReserve.estSupplyApy * 10_000));
  });

  it("prices a non-USDC reserve from the query's assetId, per pool (#539)", async () => {
    // Regression for #539: createBlendRateSource used to resolve a single
    // hardcoded USDC address, so an EURC Blend pool could never produce a
    // rate — pool.reserves.get(usdc) looked up a reserve that doesn't exist
    // there, returning null forever, silently. The query's assetId must be
    // used instead. The pool below only carries an EURC reserve, proving the
    // USDC fallback isn't what's being priced.
    const eurcReserve = makeReserveV2({
      rBase: 0.01,
      rOne: 0.04,
      rTwo: 0.5,
      rThree: 1.5,
      util: 0.8,
      curUtil: 0.7,
      address: EURC_ID,
    });
    eurcReserve.setRates(1_000_000n);
    const loadPool = vi.fn(
      async () =>
        ({ reserves: new Map([[EURC_ID, eurcReserve]]) }) as unknown as Pool
    );
    const rateSource = createBlendRateSource({ network: NETWORK, loadPool });

    const rate = await rateSource(blendQuery({ assetId: EURC_ID }));

    expect(rate).toBe(Math.round(eurcReserve.estSupplyApy * 10_000));
    expect(loadPool).toHaveBeenCalledWith(NETWORK, BLEND_POOL);
  });

  it("prefers the query's assetId over the factory's assetId option (#539)", async () => {
    // The factory's assetId option is a backwards-compatible default from the
    // pre-#539 single-asset world; a per-query assetId threaded from the
    // vault's KNOWN_POOLS entry must win, so a EURC vault isn't silently
    // priced against the USDC reserve in a pool that holds both.
    const eurcReserve = makeReserveV2({
      rBase: 0.01,
      rOne: 0.04,
      rTwo: 0.5,
      rThree: 1.5,
      util: 0.8,
      curUtil: 0.7,
      address: EURC_ID,
    });
    eurcReserve.setRates(1_000_000n);
    const usdcReserve = makeReserveV2({
      rBase: 0.02,
      rOne: 0.05,
      rTwo: 0.5,
      rThree: 1.5,
      util: 0.8,
      curUtil: 0.7,
      address: ASSET_ID,
    });
    usdcReserve.setRates(1_000_000n);
    const loadPool = vi.fn(
      async () =>
        ({
          reserves: new Map([
            [EURC_ID, eurcReserve],
            [ASSET_ID, usdcReserve],
          ]),
        }) as unknown as Pool
    );
    const rateSource = createBlendRateSource({
      network: NETWORK,
      assetId: ASSET_ID,
      loadPool,
    });

    const rate = await rateSource(blendQuery({ assetId: EURC_ID }));

    expect(rate).toBe(Math.round(eurcReserve.estSupplyApy * 10_000));
    expect(rate).not.toBe(Math.round(usdcReserve.estSupplyApy * 10_000));
  });

  it("lets a pool-load failure propagate rather than swallowing it into null", async () => {
    // runMigrationKeeper wraps every rateSource() call in withKeeperRetry
    // (see migration-keeper.ts), which classifies and retries transient
    // failures. Returning null here instead of throwing would silently
    // bypass that retry path and treat a genuine RPC blip as "rate unknown".
    const loadPool = vi.fn(async () => {
      throw new Error("Soroban RPC timed out after 100ms");
    });
    const rateSource = createBlendRateSource({ network: NETWORK, loadPool });

    await expect(rateSource(blendQuery())).rejects.toThrow(
      "Soroban RPC timed out after 100ms"
    );
  });

  it("times out the default pool loader instead of hanging indefinitely on a stuck Blend RPC call", async () => {
    vi.useFakeTimers();
    const loadSpy = vi
      .spyOn(PoolV2, "load")
      .mockReturnValue(new Promise<Pool>(() => {})); // never resolves
    const rateSource = createBlendRateSource({
      network: NETWORK,
      assetId: ASSET_ID,
    });

    const pending = rateSource(blendQuery());
    const assertion = expect(pending).rejects.toThrow(/Blend RPC timed out/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    loadSpy.mockRestore();
    vi.useRealTimers();
  });

  it("computes the same supply APR as an independent reimplementation of Blend's three-slope curve, across all three utilization regimes", () => {
    const config = {
      rBase: 0.01,
      rOne: 0.04,
      rTwo: 0.5,
      rThree: 1.5,
      util: 0.8,
    };
    const irMod = 1.0;
    const backstopTakeRate = 0.1;

    // Below target utilization, between target and 95%, and above 95%: the
    // three branches of Reserve.setRates in @blend-capital/blend-sdk.
    for (const curUtil of [0.7, 0.9, 0.97]) {
      const reserve = makeReserveV2({ ...config, curUtil });
      // Read back the exact (rounded) utilization blend-sdk itself computed
      // from the b/d supply fixture, rather than assuming it exactly equals
      // the requested curUtil: getUtilization() rounds to a 7-decimal fixed
      // point internally, and feeding the reference formula anything else
      // would compare against a slightly different input than blend-sdk
      // actually used.
      const actualUtil = reserve.getUtilizationFloat();

      reserve.setRates(BigInt(Math.round(backstopTakeRate * 10_000_000)));

      const expectedSupplyApr = referenceBlendSupplyApr(
        config,
        actualUtil,
        irMod,
        backstopTakeRate
      );

      expect(reserve.supplyApr).toBeCloseTo(expectedSupplyApr, 5);
    }
  });
});

// A from-scratch reimplementation of Reserve.setRates's rate curve (see
// node_modules/@blend-capital/blend-sdk's pool/reserve.js), independent of
// the SDK, so the test above genuinely cross-checks the formula itself
// rather than just confirming blend-sdk agrees with itself.
function referenceBlendSupplyApr(
  config: {
    rBase: number;
    rOne: number;
    rTwo: number;
    rThree: number;
    util: number;
  },
  curUtil: number,
  irMod: number,
  backstopTakeRate: number
): number {
  const { rBase, rOne, rTwo, rThree, util } = config;
  let borrowApr: number;
  if (curUtil <= util) {
    const utilScalar = curUtil / util;
    borrowApr = (utilScalar * rOne + rBase) * irMod;
  } else if (curUtil <= 0.95) {
    const utilScalar = (curUtil - util) / (0.95 - util);
    borrowApr = (utilScalar * rTwo + rOne + rBase) * irMod;
  } else {
    const utilScalar = (curUtil - 0.95) / 0.05;
    const extraRate = utilScalar * rThree;
    const intersection = irMod * (rTwo + rOne + rBase);
    borrowApr = extraRate + intersection;
  }
  const supplyCapture = (1 - backstopTakeRate) * curUtil;
  return borrowApr * supplyCapture;
}

function makeReserveV2(params: {
  rBase: number;
  rOne: number;
  rTwo: number;
  rThree: number;
  util: number;
  curUtil: number;
  address?: string;
}): ReserveV2 {
  const SCALE_7 = 10_000_000;
  const config = new ReserveConfigV2(
    0, // index
    7, // decimals (USDC-like; getUtilization()'s internal scale must match `util`'s 7-decimal encoding below)
    0, // c_factor
    0, // l_factor
    Math.round(params.util * SCALE_7),
    SCALE_7, // max_util: unused by setRates()
    Math.round(params.rBase * SCALE_7),
    Math.round(params.rOne * SCALE_7),
    Math.round(params.rTwo * SCALE_7),
    Math.round(params.rThree * SCALE_7),
    0, // reactivity: only used by accrue()'s ir_mod update, not setRates()
    0n, // supply_cap
    true
  );
  const bSupply = 1_000_000_0000000n;
  const dSupply = BigInt(Math.round(params.curUtil * 1_000_000)) * 10_000_000n;
  const RATE_SCALE_12 = 1_000_000_000_000n; // par b/d rate at rateDecimals=12
  const data = new ReserveData(
    RATE_SCALE_12, // dRate
    RATE_SCALE_12, // bRate
    10_000_000n, // interestRateModifier: 1.0x, neutral
    dSupply,
    bSupply,
    0n, // backstopCredit
    0 // lastTime
  );
  return new ReserveV2(
    BLEND_POOL,
    params.address ?? ASSET_ID,
    config,
    data,
    undefined,
    undefined,
    0,
    0,
    0,
    0,
    0
  );
}

// ---------------------------------------------------------------------------
// DeFindex
// ---------------------------------------------------------------------------

describe("createDefindexRateSource", () => {
  it("returns null and never queries the vault for a non-defindex query", async () => {
    const store = createInMemoryRateSnapshotStore();
    const rateSource = createDefindexRateSource({ network: NETWORK, store });

    const rate = await rateSource(blendQuery());

    expect(rate).toBeNull();
    expect(simulateViewMock).not.toHaveBeenCalled();
  });

  it("runs the live quote and the snapshot-store read concurrently, not sequentially", async () => {
    // Regression for PR #538 review: this is on findBestCandidate's
    // deadline-budget-constrained hot path, so the two independent reads
    // shouldn't add their latencies together. Prove it by leaving the quote
    // pending and asserting the store read still fires rather than waiting
    // for it — a sequential `await simulateView(...)` before `store.get(...)`
    // would never call store.get while the quote is still unresolved.
    let resolveQuote!: (amounts: bigint[]) => void;
    simulateViewMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveQuote = resolve))
    );
    const storeGet = vi.fn(async () => null);
    const store: RateSnapshotStore = { get: storeGet, set: vi.fn() };
    const rateSource = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => 1_000,
    });

    const pending = rateSource(defindexQuery());
    await Promise.resolve(); // flush one microtask so Promise.all's members start
    await Promise.resolve();

    expect(storeGet).toHaveBeenCalled();

    resolveQuote([10_000_000n]);
    await pending;
  });

  it("returns null on the first sample for a pool, but persists a snapshot for next time", async () => {
    simulateViewMock.mockResolvedValueOnce([10_000_000n]);
    const store = createInMemoryRateSnapshotStore();
    const rateSource = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => 1_000,
    });

    const rate = await rateSource(defindexQuery());

    expect(rate).toBeNull();
    await expect(
      store.get(`migration-keeper:defindex-rate:${DEFINDEX_VAULT}`)
    ).resolves.toEqual({ timestampMs: 1_000, priceStroops: 10_000_000n });
  });

  it("returns null when two samples are too close together to be a meaningful signal", async () => {
    const store = createInMemoryRateSnapshotStore();
    await store.set(`migration-keeper:defindex-rate:${DEFINDEX_VAULT}`, {
      timestampMs: 0,
      priceStroops: 10_000_000n,
    });
    simulateViewMock.mockResolvedValueOnce([10_050_000n]);
    const rateSource = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => 60_000, // 1 minute later, below the 10-minute floor
    });

    const rate = await rateSource(defindexQuery());

    expect(rate).toBeNull();
  });

  it("does not advance the stored anchor when a sample arrives before the interval floor, so a later call still measures from the original anchor", async () => {
    // Regression for PR #538 review: store.set previously ran unconditionally
    // before the elapsed-time check, so a too-frequent caller would slide the
    // anchor forward on every call and elapsedMs would never reach the floor.
    const store = createInMemoryRateSnapshotStore();
    const key = `migration-keeper:defindex-rate:${DEFINDEX_VAULT}`;
    await store.set(key, { timestampMs: 0, priceStroops: 10_000_000n });

    // A too-close call: returns null and must leave the anchor untouched.
    simulateViewMock.mockResolvedValueOnce([10_050_000n]);
    const tooSoon = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => 60_000, // 1 minute later, below the 10-minute floor
    });
    await tooSoon(defindexQuery());
    await expect(store.get(key)).resolves.toEqual({
      timestampMs: 0,
      priceStroops: 10_000_000n,
    });

    // A later call, now genuinely a full year past the *original* anchor,
    // should succeed with a plausible annualized rate — proving the anchor
    // never slid forward to the too-soon call's timestamp in between (a 5%
    // move extrapolated from only 10 minutes would blow past
    // MAX_PLAUSIBLE_APY and return null regardless, so the window here needs
    // to be long enough to keep the rate itself plausible).
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    simulateViewMock.mockResolvedValueOnce([10_500_000n]); // +5% over the original anchor
    const onTime = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => YEAR_MS,
    });
    const rate = await onTime(defindexQuery());

    expect(rate).not.toBeNull();
  });

  it("treats a share-price move extrapolated from the minimum sample interval as an untrustworthy blowout rather than a real rate", async () => {
    // A 1% move over the shortest usable (10-minute) window compounds to an
    // astronomical annualized figure ((1.01)^52560 - 1), not a real yield:
    // this is the exact "single skewed sample" scenario the MAX_PLAUSIBLE_APY
    // ceiling exists to catch, per PR #538 review.
    const store = createInMemoryRateSnapshotStore();
    await store.set(`migration-keeper:defindex-rate:${DEFINDEX_VAULT}`, {
      timestampMs: 0,
      priceStroops: 10_000_000n,
    });
    simulateViewMock.mockResolvedValueOnce([10_100_000n]); // +1%
    const rateSource = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => 10 * 60 * 1000, // exactly the MIN_SAMPLE_INTERVAL_MS floor
    });

    const rate = await rateSource(defindexQuery());

    expect(rate).toBeNull();
  });

  it("annualizes a 5% share-price gain over exactly one year to 500 bps", async () => {
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const store = createInMemoryRateSnapshotStore();
    await store.set(`migration-keeper:defindex-rate:${DEFINDEX_VAULT}`, {
      timestampMs: 0,
      priceStroops: 10_000_000n,
    });
    simulateViewMock.mockResolvedValueOnce([10_500_000n]); // +5%
    const rateSource = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => YEAR_MS,
    });

    const rate = await rateSource(defindexQuery());

    expect(rate).toBe(500);
  });

  it("compounds a short-window gain out to its full annualized rate", async () => {
    // A 1% gain over a 30-day window compounds to well above 12% annualized
    // (1.01^(365/30) - 1 ≈ 0.128), proving this isn't naive linear
    // extrapolation (which would report ~12.17%).
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const store = createInMemoryRateSnapshotStore();
    await store.set(`migration-keeper:defindex-rate:${DEFINDEX_VAULT}`, {
      timestampMs: 0,
      priceStroops: 100_000_000n,
    });
    simulateViewMock.mockResolvedValueOnce([101_000_000n]); // +1%
    const rateSource = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => THIRTY_DAYS_MS,
    });

    const rate = await rateSource(defindexQuery());

    const expectedApy = Math.pow(1.01, 365 / 30) - 1;
    expect(rate).toBe(Math.round(expectedApy * 10_000));
    expect(rate).toBeGreaterThan(1217); // meaningfully above the naive linear estimate
  });

  it("treats a zero or negative quoted price as unavailable and does not overwrite the stored snapshot", async () => {
    const key = `migration-keeper:defindex-rate:${DEFINDEX_VAULT}`;
    const store = createInMemoryRateSnapshotStore();
    await store.set(key, { timestampMs: 0, priceStroops: 10_000_000n });
    simulateViewMock.mockResolvedValueOnce([0n]);
    const rateSource = createDefindexRateSource({
      network: NETWORK,
      store,
      now: () => 999_999_999,
    });

    const rate = await rateSource(defindexQuery());

    expect(rate).toBeNull();
    await expect(store.get(key)).resolves.toEqual({
      timestampMs: 0,
      priceStroops: 10_000_000n,
    });
  });

  it("treats an empty or malformed amounts response as unavailable", async () => {
    simulateViewMock.mockResolvedValueOnce([]);
    const store = createInMemoryRateSnapshotStore();
    const rateSource = createDefindexRateSource({ network: NETWORK, store });

    const rate = await rateSource(defindexQuery());

    expect(rate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Snapshot stores
// ---------------------------------------------------------------------------

describe("createInMemoryRateSnapshotStore", () => {
  it("round-trips a snapshot and returns null for a missing key", async () => {
    const store = createInMemoryRateSnapshotStore();

    await expect(store.get("missing")).resolves.toBeNull();

    await store.set("key", { timestampMs: 1, priceStroops: 2n });

    await expect(store.get("key")).resolves.toEqual({
      timestampMs: 1,
      priceStroops: 2n,
    });
  });
});

describe("createUpstashRateSnapshotStore", () => {
  it("GETs by key with the bearer token and parses the stored value", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: "1234:5678" }),
    })) as unknown as typeof fetch;
    const store = createUpstashRateSnapshotStore({
      restUrl: "https://upstash.example",
      restToken: "TOKEN",
      fetchFn,
    });

    const snapshot = await store.get("mykey");

    expect(snapshot).toEqual({ timestampMs: 1234, priceStroops: 5678n });
    expect(fetchFn).toHaveBeenCalledWith("https://upstash.example/get/mykey", {
      headers: { Authorization: "Bearer TOKEN" },
      signal: expect.any(AbortSignal),
    });
  });

  it("returns null when Upstash reports no value for the key", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: null }),
    })) as unknown as typeof fetch;
    const store = createUpstashRateSnapshotStore({
      restUrl: "https://upstash.example",
      restToken: "TOKEN",
      fetchFn,
    });

    await expect(store.get("mykey")).resolves.toBeNull();
  });

  it("throws on a non-ok GET response rather than treating it as a missing snapshot", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const store = createUpstashRateSnapshotStore({
      restUrl: "https://upstash.example",
      restToken: "TOKEN",
      fetchFn,
    });

    await expect(store.get("mykey")).rejects.toThrow(/Upstash GET failed/);
  });

  it("SETs the encoded value with a TTL and the bearer token", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const store = createUpstashRateSnapshotStore({
      restUrl: "https://upstash.example/",
      restToken: "TOKEN",
      ttlSeconds: 60,
      fetchFn,
    });

    await store.set("mykey", { timestampMs: 1234, priceStroops: 5678n });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://upstash.example/set/mykey/1234%3A5678/EX/60",
      {
        method: "POST",
        headers: { Authorization: "Bearer TOKEN" },
        signal: expect.any(AbortSignal),
      }
    );
  });

  it("throws on a non-ok SET response", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const store = createUpstashRateSnapshotStore({
      restUrl: "https://upstash.example",
      restToken: "TOKEN",
      fetchFn,
    });

    await expect(
      store.set("mykey", { timestampMs: 1, priceStroops: 1n })
    ).rejects.toThrow(/Upstash SET failed/);
  });
});

// ---------------------------------------------------------------------------
// Default composite
// ---------------------------------------------------------------------------

describe("createDefaultRateSource", () => {
  it("resolves null for a protocol neither source recognizes, without querying either, and logs a warning", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rateSource = createDefaultRateSource(NETWORK, {
      env: {},
      snapshotStore: createInMemoryRateSnapshotStore(),
      logger,
    });

    const rate = await rateSource({
      protocol: "soroswap",
      adapterId: "A",
      poolId: "P",
    });

    expect(rate).toBeNull();
    expect(simulateViewMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no rate source registered"),
      expect.objectContaining({ protocol: "soroswap", poolId: "P" })
    );
  });

  it("dispatches a defindex query through the real DeFindex rate source with the given snapshot store", async () => {
    const store = createInMemoryRateSnapshotStore();
    await store.set(`migration-keeper:defindex-rate:${DEFINDEX_VAULT}`, {
      timestampMs: 0,
      priceStroops: 10_000_000n,
    });
    simulateViewMock.mockResolvedValueOnce([10_500_000n]);
    const rateSource = createDefaultRateSource(NETWORK, {
      env: {},
      snapshotStore: store,
      now: () => 365 * 24 * 60 * 60 * 1000,
    });

    const rate = await rateSource(defindexQuery());

    expect(rate).toBe(500);
  });

  it("uses an Upstash-backed snapshot store when UPSTASH_REDIS_REST_URL/TOKEN are present in env", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: null }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    simulateViewMock.mockResolvedValueOnce([10_000_000n]);
    const rateSource = createDefaultRateSource(NETWORK, {
      env: {
        UPSTASH_REDIS_REST_URL: "https://upstash.example",
        UPSTASH_REDIS_REST_TOKEN: "TOKEN",
      },
    });

    await rateSource(defindexQuery());

    expect(fetchMock).toHaveBeenCalled();
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toContain("https://upstash.example/get/");
  });

  it("falls back to an in-memory snapshot store when Upstash isn't configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    simulateViewMock.mockResolvedValueOnce([10_000_000n]);
    const rateSource = createDefaultRateSource(NETWORK, { env: {} });

    await rateSource(defindexQuery());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
