# Migration Keeper

Meridian vaults are protocol-agnostic: `migrate_adapter` already exists
(`packages/contracts/vault/src/lib.rs`) and atomically moves a vault's entire
position to a new adapter in one slippage-bounded transaction. Nothing calls
it automatically today, an admin has to notice a rate change and trigger it
by hand. This keeper closes that gap: it periodically compares live rates
across the protocols a vault's adapters can target, and calls
`migrate_adapter` when a candidate clears a configured minimum improvement.

See #469 for the full background, including why an earlier per-user
delegated-authorization design (`MeridianRouter`) was abandoned: Stellar's
token contracts require the token holder's own signature for any transfer or
burn, with no allowance/delegation primitive, so a keeper could never act on
a depositor's behalf directly. `migrate_adapter` sidesteps that entirely: it
operates on the vault's aggregate position, denominated in shares priced
against total vault value, never on any individual depositor's mUSDC. One
admin/keeper-signed call benefits every depositor simultaneously, no per-user
consent, delegation, or signature is needed.

## Current status: not yet functional against the live testnet vault

One remaining gap blocks this keeper from actually migrating anything in
practice:

- The live testnet vault (`CONTRACT_ADDRESSES.testnet.vault`) predates
  `migrate_adapter` being added to `vault/src/lib.rs` and was never
  redeployed since; it doesn't have the function at all. Confirmed directly
  via `stellar contract invoke -- --help` against the live contract. See
  #514.

Rate comparison (below) is now implemented (#511). Everything else described
in this document — the discovery, retry, deadline budget, and
structured-failure-reporting mechanism — is built and tested. Once #514
closes, this keeper is functionally complete end to end; #514 is the only
remaining blocker to a real testnet migration.

## Rate comparison

Neither adapter contract exposes a ready-made, comparable rate, so
`packages/stellar-sdk-helpers/src/rate-sources.ts` derives one for each
protocol from what's actually available on-chain:

- **Blend**: `BlendAdapter` exposes `total_assets()` (a point-in-time USDC
  value) and, via `get_pool()`, the underlying pool. Rather than
  reimplementing Blend's three-slope interest rate curve off-chain from the
  pool's raw reserve fields, `createBlendRateSource` loads the pool with
  `@blend-capital/blend-sdk` (already a dependency, used elsewhere in this
  package for position reads) and reads the reserve's own `estSupplyApy` —
  the same weekly-compounded rate estimate Blend's own indexer and UI
  compute, via `Reserve.setRates()`. This avoids a second, hand-rolled copy
  of that formula that could silently drift from Blend's actual deployed
  behavior. The reserve it prices is the vault's own asset, threaded through
  each `RateQuery` from the vault's `KNOWN_POOLS` entry (`assetId`, see
  `known-pools.ts`), falling back to the network's USDC address for a vault
  without one — so a EURC pool prices its EURC reserve, not the USDC one
  (#539).
- **DeFindex**: `DefindexAdapter` exposes `get_asset_amounts_per_shares()`, a
  live share-price snapshot with no rate on its own — a rate needs a second
  sample separated in time. `createDefindexRateSource` takes a fresh
  snapshot on every call and persists it via a pluggable `RateSnapshotStore`,
  keyed by the DeFindex vault's own contract address. The first time a given
  vault is evaluated (or any time its snapshot has expired) this correctly
  returns null — "rate unknown" — not a fabricated rate; a comparable
  annualized rate is only returned once two snapshots exist at least 10
  minutes apart. In production, `createDefaultRateSource` backs this store
  with Upstash Redis over its plain HTTP REST API, reusing the same
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` credentials
  `api/_lib/middleware.ts` already requires for its rate limiter — one
  Upstash instance backs both, no new infrastructure to provision. Without
  those set, it falls back to an in-memory store that does **not** survive
  across separate serverless invocations (each Vercel Cron tick is a fresh
  process), which in practice means DeFindex never accumulates a comparable
  rate outside of Upstash being configured.

Rate comparison stays deliberately pluggable (`RateSourceFn` in
`migration-keeper.ts`): `createDefaultRateSource(config.network)` is
`runMigrationKeeper`'s default when the caller doesn't inject
`deps.rateSource` explicitly, but nothing about the mechanism assumes it's
the only possible implementation.

## Schedule

A GitHub Actions workflow (`.github/workflows/keepers.yml`) calls
`POST /api/v1/keepers/rebalance` hourly. Not Vercel Cron: the Hobby plan
restricts Cron Jobs to once per day, which neither this nor the accrue
keeper's 15-minute schedule could express, so scheduling lives in GitHub
Actions instead (see #513 and `apps/docs/operations/accrual-keeper.md`).
Hourly, not every 15 minutes like the accrue keeper: a migration decision is
not time-sensitive the way interest accrual staleness is, and unnecessary
runs cost nothing while no candidate adapters are configured (or DeFindex
hasn't accumulated a second snapshot yet, see above), but there is no reason
to poll faster than the decision needs.

The schedule runs unconditionally, independent of whether the feature is
actually ready (#514). If `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY`
isn't set, the endpoint returns `200 { status: "disabled" }` rather than
throwing, so an intentionally-unfinished feature doesn't produce an hourly
false alarm.

## Signing Key And Trust Model

Set `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY` in the deployment secret store.

This is deliberately **not** the same key as `MERIDIAN_KEEPER_SECRET_KEY`
(the accrue keeper's key). `accrue()` is permissionless, any account can call
it. `migrate_adapter` is admin-gated (`Self::require_admin`), so this key
must be the vault's actual admin address and carries full vault admin
authority: `migrate_adapter`, `set_adapter`, `set_paused`, `transfer_admin`.
Compromising this key is equivalent to compromising the vault admin
directly. Keep it separately stored, separately rotatable, and scoped to
only the systems that need it, unlike the accrue keeper's key, this is not a
key you'd hand to a low-trust automation path.

The vault contract itself does not restrict which address `migrate_adapter`
can be pointed at beyond `require_admin`, `max_slippage_bps <= 10000`, and
`new_adapter != old_adapter`; there is no on-chain allowlist of permitted
adapter addresses. This differs from the deleted `MeridianRouter`'s
`add_vault`/`remove_vault` allowlist model. The admin gate is the entire
safety boundary: this keeper's config (`MERIDIAN_ADAPTER_<PROTOCOL>_ID`)
is what actually constrains which adapters get considered, not the
contract.

`CRON_SECRET` gates this endpoint the same way it gates `/api/v1/keepers/accrue`
(see `apps/docs/operations/accrual-keeper.md`): both production and preview
deployments fail closed when it's missing, only true local dev is permissive.

## Slippage And Improvement Thresholds

- `MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS` default `100` (1%). Passed directly
  to `migrate_adapter`'s `max_slippage_bps` argument. The config loader
  rejects only the literal `10000` (unlimited slippage): an unbounded
  tolerance would accept a migration that loses an arbitrary fraction of
  the vault's position to a stale rate read or a misbehaving adapter.
  `9999` (99.99%) is accepted and is functionally equivalent to unlimited;
  the check stops one integer short of the guarantee its own reasoning
  states. Not tightened here since picking a real ceiling below "unlimited"
  is a policy call, not a bug fix, flagging so it isn't mistaken for closed.
- `MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS` default `50` (0.5%). A candidate
  protocol's rate must exceed the vault's current rate by at least this
  much before a migration is triggered, avoiding fee-losing churn between
  two protocols whose rates are within noise of each other.

These two aren't coupled: the improvement threshold decides whether a
migration is _worth triggering_, the slippage bound decides how much value
loss a _triggered_ migration is allowed to tolerate before reverting. A
migration that clears a 50 bps improvement but loses close to the full 100
bps slippage allowance in execution is still reported as a successful,
threshold-clearing migration, and can leave the vault net worse off in the
worst case within that allowance. In practice real slippage should sit well
below the ceiling (it exists to catch a stale rate read or a misbehaving
adapter, not to describe expected cost), but nothing enforces that
assumption today.

## Candidate Adapters

`migrate_adapter(new_adapter, max_slippage_bps)` takes the address of an
already-deployed adapter contract; there is no on-chain registry of adapters
a vault could migrate to, only its single current one. Candidates are
configured out-of-band via `MERIDIAN_ADAPTER_<PROTOCOL>_ID`, one env var per
protocol (e.g. `MERIDIAN_ADAPTER_BLEND_ID`, `MERIDIAN_ADAPTER_DEFINDEX_ID`),
all unset by default; an unconfigured protocol is silently excluded from
consideration, not an error. `CandidateProtocol` deliberately doesn't exist
as a fixed type anywhere in this file: `migrate_adapter` itself has no
notion of which protocol an adapter wraps, and hardcoding a closed set of
protocol names into the keeper's config would reintroduce, at the one layer
whose job is protocol-agnostic routing, exactly the coupling adapters exist
to avoid. A new protocol becomes a candidate by setting its env var, never
by editing this codebase.

A `MeridianDefindexAdapter` is deployed on testnet
(`CAJVTA7EC3ZL3G4WSU4QIRB7RU7SUFUUJDEB7JE6CQQNPE7QC5OBSAM6`), initialized
against the live Meridian vault and the existing Paltalabs DeFindex testnet
vault, so there's a real candidate to point `MERIDIAN_ADAPTER_DEFINDEX_ID`
at once the other gaps above close. It is deliberately not wired into
`packages/shared/src/constants.ts`: that file gates a required CI check
(`.github/workflows/verify-contract-addresses.yml`) that verifies the vault
address's on-chain bytecode against source, and #514 (the live vault predating
`migrate_adapter`) already fails it independent of this address, so adding it
there would tie an inert, standalone adapter's config to an unrelated,
already-broken check. Set the env var directly instead.

Only the exact adapter address, not protocol identity, excludes a candidate
from consideration (see "Only excludes the vault's literal current adapter"
in `migration-keeper.ts`). After redeploying an adapter
(`scripts/redeploy-blend-adapter.sh`), update the corresponding
`MERIDIAN_ADAPTER_<PROTOCOL>_ID` to the new address: a stale entry still
pointing at an old, already-abandoned adapter is silently treated as a
legitimate candidate again, since it's no longer the vault's _current_
adapter either.

`config.candidateAdapters` is also a single global map applied identically
to every discovered vault, not scoped per vault. The deployed
`MeridianDefindexAdapter` above is only initialized against one specific
vault; if a second Meridian vault is ever added to `KNOWN_POOLS`, this
would need to become per-vault-scoped first (tracked on #511 alongside the
rate source work, since both matter most once a second vault is likely).

## Two-Phase Migration (`begin_migration` / `migrate_adapter`)

`migrate_adapter` requires an active `begin_migration` snapshot for the same
target adapter, at least `MIN_LEDGER_GAP` ledgers old (~1 minute), before it
will run. This closes a front-running window (issue #567): without it, an
attacker could transiently inflate a candidate adapter's reported valuation
right as a migration lands, then drain it once the funds arrive.

The keeper does not track this phase itself; the on-chain snapshot recorded
by `begin_migration` (readable via `get_migration_snapshot`) is the only
state it needs. On each run, before attempting `migrate_adapter` for the
chosen candidate:

1. Read `get_migration_snapshot()`. If it traps (no active migration) or its
   `adapter` doesn't match the candidate, this run's target has no live
   cooldown in progress.
2. In that case, submit `begin_migration(candidate)` instead of
   `migrate_adapter`, and stop for this vault — the result records this as
   `skipped`, not `failed`. The submission lease taken for this run is
   released immediately (`releaseIfUnsent`) rather than held for the
   `submissionTtlMs` window, so it doesn't block a subsequent run from
   picking the vault back up.
3. If the snapshot does match the candidate, proceed to `migrate_adapter` as
   before. The keeper does not duplicate the contract's ledger-gap math to
   decide whether the cooldown has elapsed: if it hasn't, `migrate_adapter`
   itself rejects the call with `MigrationCooldownNotMet` during simulation
   (no fee, nothing sent), which is reported as a `failures` entry and
   naturally retried on a later scheduled run. This is deliberately simple
   rather than precise — `MIN_LEDGER_GAP` is ~1 minute and this keeper runs
   on an hourly schedule, so the cooldown has always long since elapsed by
   the run after `begin_migration` fired.

A migration to a given candidate therefore normally spans two scheduled
runs: one that calls `begin_migration`, and the next that calls
`migrate_adapter` once the on-chain snapshot is old enough.

## Retry And Failure Handling

Discovery and submission follow the same shape as the accrue keeper (see
`apps/docs/operations/accrual-keeper.md`): transient failures retry with
exponential backoff, an unconfirmed `migrate_adapter` transaction is
re-checked by hash on retry rather than resubmitted, a definitive on-chain
failure (e.g. slippage exceeded) is reported immediately without retrying,
and the run stops starting new work once it's within `vercel.json`'s
`maxDuration` budget rather than risk being killed mid-retry.

## Cross-Invocation Duplicate Protection

`priorHash` (in `keeper-tx.ts`) only tracks an unconfirmed transaction
_within_ one invocation. That alone is not enough here: if the process is
killed, or a run exhausts its retries while a `migrate_adapter` transaction
is sent but unconfirmed, the next scheduled run would have no memory of it
and could send a second, independent migration while the first is still
landing. Unlike `accrue()`, that isn't free, each call is its own
slippage-bounded transaction, so a double-migration costs real slippage
twice.

Two guards close that, and they cover different failure windows.

### 1. A shared submission lease

Held in Upstash Redis (`packages/stellar-sdk-helpers/src/keeper-state.ts`),
one record per vault, keyed `meridian:keeper:migration:<network>:<vaultId>`.
It is taken in two steps:

1. **Claim** (`SET NX`) **before the transaction is built.** A plain "is
   there a record?" read would not be a claim: two genuinely concurrent
   invocations, a scheduled run overlapping a manual `workflow_dispatch`,
   could both read nothing and both broadcast. The claim carries no hash
   yet, and expires after `DEFAULT_CLAIM_TTL_MS` (60s), which only has to
   cover build + simulate + sign.
2. **Record the hash as soon as the transaction is signed**, before
   `sendTransaction` is called, with a compare-and-set against the claim.
   The hash comes from the signed transaction itself, so a transaction that
   reaches the mempool and then times out, or comes back `TRY_AGAIN_LATER`,
   is always covered. Recording only after a successful send would miss
   exactly the cases that produce duplicates.

The cost of step 2 is deliberate: a crash between signing and broadcasting
leaves a record for a transaction that never went out. That is bounded, not
a lockup, the record ages out at the transaction's own validity window,
which is exactly when it becomes provably unable to land, so the worst case
is a delayed retry rather than a duplicate migration.

Every write after the claim is conditional on the exact record this run put
there. Without that, a slow run could clear a record a newer run had already
replaced, handing a third run a clean slate to rebroadcast into. A run that
loses its lease (claim expired, another run took the key) stops touching it
and logs that it did.

At the start of every run, an existing record is **resolved against the
network**, never trusted on its own word:

| State of the record                             | Meaning                              | Action                       |
| ----------------------------------------------- | ------------------------------------ | ---------------------------- |
| claim only, inside the claim window             | another run is mid-build             | **skip this vault this run** |
| claim only, past the claim window               | that run died before signing         | clear, evaluate again        |
| hash, lookup `SUCCESS`                          | the migration landed                 | clear, evaluate again        |
| hash, lookup `FAILED`                           | it failed on-chain                   | clear, retry allowed         |
| hash, not found, older than the validity window | provably dead, it can never land now | clear, retry allowed         |
| hash, not found, still inside that window       | genuinely still in flight            | **skip this vault this run** |
| the store or the lookup itself errored          | unknown                              | **skip this vault this run** |

So a record can never block a vault indefinitely: it either resolves to a
real outcome or ages out. `MERIDIAN_KEEPER_SUBMISSION_TTL_MS` defaults to
`360000` (the 300s transaction validity window plus 60s of clock-skew
margin) and is **rejected below 300000**: a shorter TTL would clear the
record while its transaction could still land, turning the expiry rule into
a duplicate generator. Records also carry a Redis-side expiry, so a run that
dies before it can clear one cannot leave it behind indefinitely.

An unreadable store is treated as _unknown_, not as "nothing was submitted":
reading a KV outage as "safe to migrate" would produce exactly the duplicate
this exists to prevent. Migrations pause (visibly, in `skipped[]`) until the
store is reachable again. Every store and status call is time-bounded, so a
black-holed connection can't hang the run past its `maxDuration` budget.

Because a per-process fallback cannot dedup across invocations at all, the
migration keeper **refuses to run on any deployment** (production _and_
preview) without `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`.
Preview is included deliberately: preview deployments sign real transactions
off a real key, and `api/_lib/middleware.ts` only fails closed on
production. Local dev falls back to a per-invocation store and says so.

`deps.submitMigration` is handed the lease's hooks. An injected submitter
that forwards them to `submitKeeperOperation` keeps full dedup; one that
ignores them keeps only the claim and the on-chain re-check, and the run
warns at startup that it is in that state.

### 2. The on-chain adapter re-check

Before building a brand-new transaction (not when rechecking an already-sent
one), the keeper re-reads the vault's live `get_adapter()` and compares it
against what discovery saw for this run. A mismatch means something else
already changed the vault's adapter, and the migration is skipped rather
than submitted against stale assumptions.

This is not redundant with the lease: it covers the case where a migration
already landed and the record has since been cleared or aged out. A TOCTOU
gap still remains between the re-check and the transaction landing
(unavoidable without a contract-level compare-and-swap), which is why both
guards exist rather than either alone.

Skips from either guard land in `skipped[]`, not `failures[]`: both are
benign, expected races, and a keeper that returned HTTP 500 every time one
fired would page someone for correct behavior.

## Coordination With The Accrue Keeper

The two keepers act on the same vault's adapter independently. The accrue
keeper can read `get_adapter()` at discovery, have this keeper switch the
vault to a different adapter before its submission lands, and then call
`accrue()` on the now-detached adapter, a silently ineffective call (a
detached adapter is still a valid contract, so nothing errors) whose yield
never reaches the vault.

The accrue keeper therefore runs the same live-`get_adapter()` re-check
before building its own transaction, and skips when the vault has moved on
(see `apps/docs/operations/accrual-keeper.md`). No lock or shared ordering
between the two keepers is introduced: each independently refuses to act on
an adapter the vault no longer uses, which is enough to make the race benign
without coupling their schedules.

The two keepers also differ on what an unreadable store means, on purpose.
This keeper stops; the accrue keeper proceeds and warns. Stopping accrual
for the length of a KV outage would leave every vault's TVL/APY stale to
avoid a duplicate that costs one Soroban fee, which is the wrong trade in
that direction and the right one here.
