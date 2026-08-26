// Real RateSourceFn implementations for the migration keeper (#469), filling
// in the always-null stub that used to live in migration-keeper.ts (#511).
// See that file's RateQuery/RateSourceFn docs for the contract both sources
// below must honor: resolve a comparable annualized rate in basis points, or
// null when it genuinely can't be determined yet (never throw for "unknown",
// only for a failed lookup the keeper's own retry logic should handle).
//
// Deliberately does NOT catch-and-null network/RPC errors from either
// source: runMigrationKeeper wraps every rateSource() call in
// withKeeperRetry (see keeper-retry.ts), which classifies and retries
// transient failures. Swallowing them here would silently bypass that.

import { PoolV2, type Pool } from "@blend-capital/blend-sdk";
import { CONTRACT_ADDRESSES, withRaceTimeout } from "@meridian/shared";
import { getRpcServer } from "./internal";
import { withBlendTimeout } from "./blend";
import { getDefindexAssetAmountPerShares } from "./defindex";
import type { StellarNetwork } from "./types";
import { consoleLogger, type KeeperLogger } from "./keeper-retry";
import type { RateQuery, RateSourceFn } from "./migration-keeper";

const BPS_SCALAR = 10_000;

function toFiniteBps(rate: number): number | null {
  const bps = rate * BPS_SCALAR;
  return Number.isFinite(bps) ? Math.round(bps) : null;
}

// ---------------------------------------------------------------------------
// Blend
// ---------------------------------------------------------------------------

export interface BlendRateSourceOptions {
  network: StellarNetwork;
  // Reserve asset to price. Meridian vaults are single-asset today (USDC);
  // hardcoding this per network mirrors blend.ts's blendAssetForVault. It
  // isn't threaded through RateQuery itself: that type is a deliberately
  // unchanged public seam (protocol/adapterId/poolId only), see
  // migration-keeper.ts.
  assetId?: string;
  // Injectable for tests; defaults to the real SDK loader.
  loadPool?: (network: StellarNetwork, poolId: string) => Promise<Pool>;
}

/**
 * Prices a Blend pool's current supply rate for `assetId` using
 * @blend-capital/blend-sdk's own Reserve model (`Reserve.setRates`, the same
 * three-slope kinked-curve math Blend's own indexer and UI read) rather than
 * a hand-rolled reimplementation of it off the raw fields BlendAdapter
 * exposes. `estSupplyApy` (Blend's own weekly-compounded estimate) is used
 * rather than the raw `supplyApr` so the comparison against DeFindex's
 * realized, compounded rate below is apples-to-apples: both are annualized
 * yields, not one APR next to one APY.
 */
export function createBlendRateSource(
  options: BlendRateSourceOptions
): RateSourceFn {
  // Mirrors tx.ts's allowedContractIds: CONTRACT_ADDRESSES only has
  // testnet/mainnet entries, futurenet (used for local/CI RPC pointed at a
  // futurenet node) falls back to testnet's addresses.
  const addressKey =
    options.network.network === "mainnet" ? "mainnet" : "testnet";
  const assetId = options.assetId ?? CONTRACT_ADDRESSES[addressKey].usdc;
  const loadPool =
    options.loadPool ??
    ((network: StellarNetwork, poolId: string) =>
      withBlendTimeout(() =>
        PoolV2.load(
          { rpc: network.rpcUrl, passphrase: network.passphrase },
          poolId
        )
      ));

  return async (query: RateQuery) => {
    if (query.protocol !== "blend") return null;
    const pool = await loadPool(options.network, query.poolId);
    const reserve = pool.reserves.get(assetId);
    if (!reserve) return null;
    return toFiniteBps(reserve.estSupplyApy);
  };
}

// ---------------------------------------------------------------------------
// DeFindex
// ---------------------------------------------------------------------------

// DeFindex's vault contract exposes no on-chain rate, only a live
// share-price snapshot (get_asset_amounts_per_shares). Deriving a rate needs
// two samples separated in time; RateSnapshotStore is the persistence seam
// for that. See createUpstashRateSnapshotStore for the answer this ships
// with, and createInMemoryRateSnapshotStore's own doc for why it is NOT a
// production substitute.
export interface RateSnapshot {
  timestampMs: number;
  // USDC stroops for REFERENCE_SHARES worth of dfTokens, at timestampMs.
  priceStroops: bigint;
}

export interface RateSnapshotStore {
  get(key: string): Promise<RateSnapshot | null>;
  set(key: string, snapshot: RateSnapshot): Promise<void>;
}

/**
 * Per-process, in-memory only: on a serverless deployment (this repo runs on
 * Vercel, see vercel.json) each invocation is a fresh process, so a snapshot
 * written here never survives to be read by the next scheduled run. Useful
 * for local dev and tests; createDefaultRateSource only falls back to this
 * when Upstash credentials aren't configured (see below), and logs nothing
 * migrates as a result, exactly the same "rate unknown" outcome as before
 * this file existed, never a hard failure.
 */
export function createInMemoryRateSnapshotStore(): RateSnapshotStore {
  const store = new Map<string, RateSnapshot>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, snapshot) {
      store.set(key, snapshot);
    },
  };
}

export interface UpstashRateSnapshotStoreOptions {
  restUrl: string;
  restToken: string;
  // Keys expire after this long: an adapter/pool nobody has evaluated in a
  // while shouldn't hold a snapshot forever that a much-later comparison
  // would wrongly treat as a live "prior sample" spanning the gap.
  ttlSeconds?: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

// Matches keeper-state.ts's DEFAULT_STORE_TIMEOUT_MS: this call sits on the
// same deadline-budget-constrained hot path (findBestCandidate), so a hung
// Upstash request shouldn't be able to stall the run past it.
const DEFAULT_UPSTASH_TIMEOUT_MS = 5_000;

/**
 * Persists snapshots via Upstash's plain HTTP REST API rather than the
 * @upstash/redis SDK: this package has no Redis dependency today, and the
 * two commands needed (GET/SET) don't need one. Reuses the same
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN credentials
 * api/_lib/middleware.ts already requires in production for its rate
 * limiter, so wiring this up needs no new infrastructure, just an existing
 * Upstash instance.
 */
export function createUpstashRateSnapshotStore(
  options: UpstashRateSnapshotStoreOptions
): RateSnapshotStore {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SNAPSHOT_TTL_SECONDS;
  const fetchFn = options.fetchFn ?? fetch;
  const restUrl = options.restUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${options.restToken}` };
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTASH_TIMEOUT_MS;

  return {
    async get(key) {
      const res = await withRaceTimeout(
        () =>
          fetchFn(`${restUrl}/get/${encodeURIComponent(key)}`, {
            headers,
            // Belt and braces with the race below: this also frees the
            // socket rather than leaving a hung request running past the
            // run, matching keeper-state.ts's command().
            signal: AbortSignal.timeout(timeoutMs),
          }),
        timeoutMs,
        "Upstash Redis"
      );
      if (!res.ok) {
        throw new Error(`Upstash GET failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { result: string | null };
      if (!body.result) return null;
      const [timestampMsRaw, priceStroopsRaw] = body.result.split(":");
      if (!timestampMsRaw || !priceStroopsRaw) return null;
      return {
        timestampMs: Number(timestampMsRaw),
        priceStroops: BigInt(priceStroopsRaw),
      };
    },
    async set(key, snapshot) {
      const value = `${snapshot.timestampMs}:${snapshot.priceStroops}`;
      // All-path-segments form, per Upstash's documented REST API
      // (`REST_URL/set/foo/bar/EX/100`). The POST-with-body form
      // (`POST /set/foo?EX=100`, value in the request body) is the other
      // documented shape; a POST with the value already in the path AND EX
      // as a query string, which is what this used to send, is neither.
      const res = await withRaceTimeout(
        () =>
          fetchFn(
            `${restUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${ttlSeconds}`,
            {
              method: "POST",
              headers,
              signal: AbortSignal.timeout(timeoutMs),
            }
          ),
        timeoutMs,
        "Upstash Redis"
      );
      if (!res.ok) {
        throw new Error(`Upstash SET failed: HTTP ${res.status}`);
      }
    },
  };
}

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

// get_asset_amounts_per_shares is a pure proportional query (see
// MeridianDefindexAdapter::total_assets, packages/contracts/defindex-adapter
// /src/lib.rs, which calls it with the adapter's own live share balance to
// price whatever it happens to hold) — any fixed share count works equally
// well as a price probe here. 1.0 unit at the 7-decimal stroop scale every
// other Meridian amount uses keeps a persisted snapshot's magnitude easy to
// sanity-check by hand.
const REFERENCE_SHARES = 10_000_000n;

// Below this, two samples are too close together for their price delta to
// be a meaningful annualized signal: ordinary rounding in a single-digit-bps
// share-price move gets amplified enormously once extrapolated out to a
// full year. The keeper runs hourly in production (see
// apps/docs/operations/migration-keeper.md's Schedule section), comfortably
// above this floor in normal operation.
const MIN_SAMPLE_INTERVAL_MS = 10 * 60 * 1_000;

// Even at the MIN_SAMPLE_INTERVAL_MS floor, extrapolating to a full year
// means raising (1 + growth) to a power of roughly 52,000. A single large
// deposit/withdrawal skewing get_asset_amounts_per_shares within one sample
// window (not necessarily a DeFindex bug) is enough to produce a finite but
// absurd APY that would otherwise win the migration comparison outright
// against Blend's real rate (see PR #538 review). No real stablecoin yield
// source approaches this, so treat anything above it as an untrustworthy
// extrapolation rather than a real rate.
const MAX_PLAUSIBLE_APY = 5; // 500% annualized

function snapshotKey(poolId: string): string {
  return `migration-keeper:defindex-rate:${poolId}`;
}

export interface DefindexRateSourceOptions {
  network: StellarNetwork;
  store: RateSnapshotStore;
  now?: () => number;
}

/**
 * Takes a fresh DeFindex share-price snapshot on every call, persists it via
 * `store`, and returns a comparable annualized rate only once a second,
 * sufficiently time-separated snapshot already exists for the same DeFindex
 * vault. The first time a given vault is evaluated (or any time after its
 * snapshot has expired, see createUpstashRateSnapshotStore's ttlSeconds),
 * this returns null — "rate unknown", the same outcome the always-null stub
 * always produced, not a failure.
 *
 * This is the explicit answer to "where does the time-series sample live"
 * that #469 asked this issue to resolve: in `store`, keyed by the DeFindex
 * vault's own contract address (query.poolId), never on this otherwise
 * stateless keeper process. createDefaultRateSource below wires `store` to
 * Upstash Redis when configured (see createUpstashRateSnapshotStore).
 */
export function createDefindexRateSource(
  options: DefindexRateSourceOptions
): RateSourceFn {
  const now = options.now ?? Date.now;

  return async (query: RateQuery) => {
    if (query.protocol !== "defindex") return null;

    const server = getRpcServer(options.network.rpcUrl, 10_000);
    const key = snapshotKey(query.poolId);
    // Independent reads (the live quote and the persisted prior snapshot),
    // run concurrently rather than sequentially: this is on
    // findBestCandidate's deadline-budget-constrained hot path (see
    // migration-keeper.ts), so their latencies shouldn't just add up.
    //
    // Promise.allSettled, not Promise.all: this function is itself wrapped
    // in withKeeperRetry (see this file's header comment), which re-invokes
    // it on a retry. Promise.all rejects as soon as either promise rejects,
    // leaving the other still running unobserved; a retry started right
    // after would then have two concurrent RPC/store calls in flight for
    // the same query, the same orphaned-promise failure mode
    // discoverMigrationVaults's own Promise.allSettled comment (
    // migration-keeper.ts) documents. Waiting for both to settle before
    // re-throwing closes that window.
    const [priceStroopsResult, priorResult] = await Promise.allSettled([
      getDefindexAssetAmountPerShares(
        server,
        query.poolId,
        options.network.passphrase,
        REFERENCE_SHARES
      ),
      options.store.get(key),
    ]);
    if (priceStroopsResult.status === "rejected")
      throw priceStroopsResult.reason;
    if (priorResult.status === "rejected") throw priorResult.reason;
    const priceStroops = priceStroopsResult.value;
    const prior = priorResult.value;
    const timestampMs = now();
    const elapsedMs = prior ? timestampMs - prior.timestampMs : null;

    // Only advance the stored anchor once a full interval has actually
    // elapsed since the prior one (or there was no prior at all). Overwriting
    // it on every call, including a too-recent one, would slide the anchor
    // forward indefinitely, so the gap would never reach
    // MIN_SAMPLE_INTERVAL_MS if this is ever called more often than that.
    if (
      priceStroops !== null &&
      priceStroops > 0n &&
      (elapsedMs === null || elapsedMs >= MIN_SAMPLE_INTERVAL_MS)
    ) {
      await options.store.set(key, { timestampMs, priceStroops });
    }

    if (
      !prior ||
      priceStroops === null ||
      priceStroops <= 0n ||
      prior.priceStroops <= 0n ||
      elapsedMs === null ||
      elapsedMs < MIN_SAMPLE_INTERVAL_MS
    ) {
      return null;
    }

    // Converting to Number loses precision once a value exceeds 2^53 stroops
    // (~$900M at 7-decimal USDC); growth is a ratio, so this only matters for
    // implausibly large vaults, but it degrades silently rather than erroring.
    const growth =
      Number(priceStroops - prior.priceStroops) / Number(prior.priceStroops);
    const elapsedYears = elapsedMs / (SECONDS_PER_YEAR * 1000);
    const apy = Math.pow(1 + growth, 1 / elapsedYears) - 1;
    if (!(Math.abs(apy) <= MAX_PLAUSIBLE_APY)) return null;
    return toFiniteBps(apy);
  };
}

// ---------------------------------------------------------------------------
// Default composite
// ---------------------------------------------------------------------------

export interface DefaultRateSourceOptions {
  assetId?: string;
  snapshotStore?: RateSnapshotStore;
  now?: () => number;
  // Defaults to process.env. Overridable for tests; loadMigrationKeeperConfig
  // elsewhere in this package follows the same explicit-env-object pattern
  // rather than reading process.env deep inside library code.
  env?: Record<string, string | undefined>;
  logger?: KeeperLogger;
}

// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN: the same variables
// api/_lib/middleware.ts already requires in production for its rate
// limiter (Redis.fromEnv() reads them under the hood there). Reused here
// rather than introducing a migration-keeper-specific pair, so one Upstash
// instance backs both and no new infrastructure needs provisioning to make
// the DeFindex comparison real.
function upstashSnapshotStoreFromEnv(
  env: Record<string, string | undefined>
): RateSnapshotStore | null {
  const restUrl = env.UPSTASH_REDIS_REST_URL?.trim();
  const restToken = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!restUrl || !restToken) return null;
  return createUpstashRateSnapshotStore({ restUrl, restToken });
}

/**
 * The real RateSourceFn wired as runMigrationKeeper's default (see
 * migration-keeper.ts), replacing the always-null stub. Dispatches via a
 * protocol -> RateSourceFn registry rather than a switch, since adapter
 * discovery itself is config-driven (scans MERIDIAN_ADAPTER_<PROTOCOL>_ID,
 * see loadMigrationKeeperConfig) and can surface a protocol neither source
 * here covers. That still resolves null — the same
 * "current rate unavailable" outcome the keeper already handles for a rate
 * source that doesn't cover every candidate (see migration-keeper.ts's
 * `isUsableRate` and findBestCandidate's anyRateKnown handling) — but is
 * logged, since silently and permanently returning null for a configured
 * adapter is a config gap worth surfacing, not routine "no rate yet" noise.
 */
export function createDefaultRateSource(
  network: StellarNetwork,
  options: DefaultRateSourceOptions = {}
): RateSourceFn {
  const logger = options.logger ?? consoleLogger;

  const blend = createBlendRateSource({
    network,
    ...(options.assetId !== undefined && { assetId: options.assetId }),
  });

  const snapshotStore =
    options.snapshotStore ??
    upstashSnapshotStoreFromEnv(options.env ?? process.env) ??
    createInMemoryRateSnapshotStore();
  const defindex = createDefindexRateSource({
    network,
    store: snapshotStore,
    ...(options.now !== undefined && { now: options.now }),
  });

  const registry: Record<string, RateSourceFn> = {
    blend,
    defindex,
  };

  return async (query: RateQuery) => {
    const source = registry[query.protocol];
    if (!source) {
      logger.warn(
        "[rate-sources] no rate source registered for protocol; rate will stay unknown",
        { protocol: query.protocol, poolId: query.poolId }
      );
      return null;
    }
    return source(query);
  };
}
