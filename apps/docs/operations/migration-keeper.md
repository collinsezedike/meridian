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

Two independent gaps, tracked separately, both must close before this keeper
actually migrates anything in practice:

- The live testnet vault (`CONTRACT_ADDRESSES.testnet.vault`) predates
  `migrate_adapter` being added to `vault/src/lib.rs` and was never
  redeployed since; it doesn't have the function at all. Confirmed directly
  via `stellar contract invoke -- --help` against the live contract. See
  #514.
- Rate comparison isn't implemented (below). See #511.

Everything else described in this document, the discovery, retry, deadline
budget, and structured-failure-reporting mechanism, is built and tested; it
has nothing real to act on yet.

## Rate comparison is not implemented yet

Neither adapter contract exposes a ready-made, comparable rate:

- `BlendAdapter` exposes `total_assets()` (a point-in-time USDC value) and
  the underlying pool's raw reserve data (utilization, the kinked-curve
  parameters `r_base`/`r_one`/`r_two`/`r_three`). Turning that into a current
  interest rate means reimplementing Blend's three-slope interest rate
  formula off-chain. Nothing in this codebase does that today.
- `DefindexAdapter` exposes `get_asset_amounts_per_shares()`, a share-price
  snapshot. Deriving a rate from that needs a second sample over time; no
  history is stored anywhere for it either.

Rate comparison is deliberately pluggable (`RateSourceFn` in
`packages/stellar-sdk-helpers/src/migration-keeper.ts`) rather than guessed
at. The default implementation always returns `null` ("rate unknown"), so
**the keeper never migrates anything until a real rate source is injected**.
Implementing either protocol's rate formula is separate, dedicated follow-up
work, not rushed into the mechanism this PR ships.

## Schedule

Vercel Cron calls `GET /api/v1/keepers/rebalance` hourly, as configured in
`vercel.json`. Hourly, not every 15 minutes like the accrue keeper: a
migration decision is not time-sensitive the way interest accrual staleness
is, and unnecessary runs cost nothing while the rate source is unconfigured,
but there is no reason to poll faster than the decision needs.

## Signing Key And Trust Model

Set `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY` in the deployment secret store.

This is deliberately **not** the same key as `MERIDIAN_KEEPER_SECRET_KEY`
(the accrue keeper's key). `accrue()` is permissionless, any account can call
it. `migrate_adapter` is admin-gated (`Self::require_admin`), so this key
must be the vault's actual admin address and carries full vault admin
authority: `migrate_adapter`, `set_adapter`, `set_paused`, `set_admin`.
Compromising this key is equivalent to compromising the vault admin
directly. Keep it separately stored, separately rotatable, and scoped to
only the systems that need it, unlike the accrue keeper's key, this is not a
key you'd hand to a low-trust automation path.

`CRON_SECRET` gates this endpoint the same way it gates `/api/v1/keepers/accrue`
(see `apps/docs/operations/accrual-keeper.md`): both production and preview
deployments fail closed when it's missing, only true local dev is permissive.

## Slippage And Improvement Thresholds

- `MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS` default `100` (1%). Passed directly
  to `migrate_adapter`'s `max_slippage_bps` argument. The config loader
  rejects `10000` (unlimited slippage): an unbounded tolerance would accept a
  migration that loses an arbitrary fraction of the vault's position to a
  stale rate read or a misbehaving adapter.
- `MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS` default `50` (0.5%). A candidate
  protocol's rate must exceed the vault's current rate by at least this
  much before a migration is triggered, avoiding fee-losing churn between
  two protocols whose rates are within noise of each other.

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

## Retry And Failure Handling

Discovery and submission follow the same shape as the accrue keeper (see
`apps/docs/operations/accrual-keeper.md`): transient failures retry with
exponential backoff, an unconfirmed `migrate_adapter` transaction is
re-checked by hash on retry rather than resubmitted, a definitive on-chain
failure (e.g. slippage exceeded) is reported immediately without retrying,
and the run stops starting new work once it's within `vercel.json`'s
`maxDuration` budget rather than risk being killed mid-retry. Unlike
`accrue()`, `migrate_adapter` is not idempotent-in-effect: a duplicate call
would attempt to move an already-migrated position again and fail on
`SameAdapter`. The in-flight-transaction tracking here prevents that
duplicate call, a fund-safety property this keeper depends on.
