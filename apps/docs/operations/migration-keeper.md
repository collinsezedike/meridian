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

A GitHub Actions workflow (`.github/workflows/keepers.yml`) calls
`POST /api/v1/keepers/rebalance` hourly. Not Vercel Cron: the Hobby plan
restricts Cron Jobs to once per day, which neither this nor the accrue
keeper's 15-minute schedule could express, so scheduling lives in GitHub
Actions instead (see #513 and `apps/docs/operations/accrual-keeper.md`).
Hourly, not every 15 minutes like the accrue keeper: a migration decision is
not time-sensitive the way interest accrual staleness is, and unnecessary
runs cost nothing while the rate source is unconfigured, but there is no
reason to poll faster than the decision needs.

The schedule runs unconditionally, independent of whether the feature is
actually ready (#511, #514). If `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY`
isn't set, the endpoint returns `200 { status: "disabled" }` rather than
throwing, so an intentionally-unfinished feature doesn't produce an hourly
false alarm.

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

## Retry And Failure Handling

Discovery and submission follow the same shape as the accrue keeper (see
`apps/docs/operations/accrual-keeper.md`): transient failures retry with
exponential backoff, an unconfirmed `migrate_adapter` transaction is
re-checked by hash on retry rather than resubmitted, a definitive on-chain
failure (e.g. slippage exceeded) is reported immediately without retrying,
and the run stops starting new work once it's within `vercel.json`'s
`maxDuration` budget rather than risk being killed mid-retry.

The in-flight-transaction tracking (`priorHash`) only covers a single
invocation, exactly like the accrue keeper's own version of this gap (see
`apps/docs/operations/accrual-keeper.md`). If the process is killed (or a
run exhausts its retries) while a `migrate_adapter` transaction is sent but
still unconfirmed, the next scheduled run has no memory of it: discovery
reads whatever adapter is live on-chain at that point and evaluates fresh,
so it will not deliberately resend the exact same migration, but if the
prior transaction is still landing when the next run fires, a second,
independent `migrate_adapter` call can still go out before the first
confirms. Unlike `accrue()`, this isn't free: each call is its own
slippage-bounded transaction, so a genuine double-migration costs real
slippage twice. This is an accepted, bounded gap
covered by the same cross-invocation persistence work needed for the accrue
keeper, not something this keeper solves on its own (tracked in #515, which
also needs to account for the accrue keeper racing against this one: both
act on the same vault's adapter independently, with no coordination between
them, see #515 for the full scope once `migrate_adapter` is actually live
on the vault).

Before building a brand-new transaction (not when rechecking an
already-sent one), the keeper re-reads the vault's live `get_adapter()` and
compares it against what discovery saw for this run. A mismatch means
something else already changed the vault's adapter since this run started,
and the migration is skipped rather than submitted against stale
assumptions. This narrows the cross-invocation race window; it does not
close it, a mismatch can still occur between this check and the
transaction actually landing on-chain (an unavoidable TOCTOU gap without a
contract-level compare-and-swap), but it catches the common case of "a
prior run's migration already landed" for free.
