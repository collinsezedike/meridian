# Blend Accrual Keeper

Meridian Blend adapters cache `total_assets()`. Deposits and withdrawals update
that cache, but passive Blend interest is only reflected after a real
`accrue()` transaction lands on-chain. Read-only simulations do not persist
state, so the production deployment runs a scheduled keeper.

## Schedule

A GitHub Actions workflow (`.github/workflows/keepers.yml`) calls
`POST /api/v1/keepers/accrue` every 15 minutes. Not Vercel Cron: the Hobby
plan restricts Cron Jobs to once per day, which can't express a 15-minute
interval, so scheduling lives in GitHub Actions instead, authenticating with
the same `CRON_SECRET` bearer token Vercel Cron would have used. See #513.

GitHub disables scheduled workflows after 60 days of repository inactivity
(no pushes); an active repo keeps this running indefinitely, but a long-quiet
fork or mirror would need the workflow manually re-enabled. Scheduled-workflow
timing is also best-effort, not exact-to-the-minute, acceptable for a
15-minute interval but worth knowing if staleness ever looks slightly off
from the nominal window below.

With successful runs, the expected maximum TVL/APY staleness window for
Blend-backed Meridian vaults is one keeper interval: 15 minutes. Dashboard HTTP
caching may add up to another 60 seconds on mainnet responses. If a keeper run
fails, values can remain stale until the next successful run; failed runs return
a non-2xx status so hosting alerts and cron logs can detect them.

This guarantee only covers vaults the keeper actually discovers, `KNOWN_POOLS`
entries with `protocol: "meridian"` and a `contractId` set for the running
network. As of this writing `KNOWN_POOLS.mainnet` has no such entries (no
Meridian vault is deployed on mainnet yet), so the cron currently runs on
mainnet, finds zero adapters, and returns a successful empty result every 15
minutes, not a failure, and not evidence of a live guarantee. Once a mainnet
vault is deployed and added to `KNOWN_POOLS.mainnet`, it starts being covered
automatically on the next run.

## Signing Key

Set `MERIDIAN_KEEPER_SECRET_KEY` in the deployment secret store. It must be the
Stellar secret seed for a funded keeper account that can pay Soroban fees. The
key is read from environment variables injected by the platform; never commit
it to source control.

The legacy fallback name `KEEPER_SECRET_KEY` is also accepted, but new
deployments should use `MERIDIAN_KEEPER_SECRET_KEY`.

Set `CRON_SECRET` as a separate secret, in both Vercel's environment
variables (what the endpoint itself checks) and as a GitHub Actions
repository secret of the same name and value (what `keepers.yml` sends).
Scheduled calls must include `Authorization: Bearer $CRON_SECRET`; both
production and preview deployments fail closed when `CRON_SECRET` is
missing, only true local dev (no `VERCEL_ENV` at all) is permissive. Unlike
simple rate-limit relaxation elsewhere, this endpoint triggers real signed
transactions off the keeper's funded account, so an unauthenticated preview
URL is a real gas-drain risk.

Also set `API_BASE_URL` as a GitHub Actions repository **variable** (not a
secret, it's just the deployment's public URL) to the production domain
`keepers.yml` should call.

## Discovery

The keeper discovers adapters from live Meridian coordinator vault entries in
`KNOWN_POOLS`:

1. Call `vault.get_adapter()`.
2. Call `adapter.get_protocol()`.
3. Submit `adapter.accrue()` only when the protocol is exactly `blend`.

DeFindex-backed adapters are skipped because their `total_assets()` value is
computed live and does not require a separate accrue transaction.

## Retry And Failure Handling

Each Blend accrue submission is built from a freshly loaded source account, then
simulated, assembled, signed, submitted, and confirmed before the keeper moves
to the next adapter. Rebuilding on retry avoids reusing stale sequence numbers.

Transient submission failures retry with exponential backoff. Configure:

- `MERIDIAN_KEEPER_MAX_ATTEMPTS` default `3`
- `MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS` default `1000`
- `MERIDIAN_KEEPER_RPC_TIMEOUT_MS` default `10000`

Failures are logged with the vault id, adapter id, protocol, stage, attempt
count, and error summary. Any discovery or submission failure is also included
in the endpoint response. If at least one failure occurs, the endpoint returns
HTTP 500 so the scheduled run is observable instead of silently passing.

If a submitted `accrue()` transaction is still unconfirmed when a retry
attempt times out, the keeper re-checks that same transaction hash instead of
sending a new one, within a single run.

That tracking also persists **across** invocations (#515). The submitted
hash is recorded in the shared store (Upstash Redis, keyed
`meridian:keeper:accrual:<network>:<vaultId>:<adapterId>`) as soon as the
transaction is broadcast, and every run resolves an existing record against
the network before submitting anything: landed, failed, or aged out past the
transaction's validity window clears it, and only a genuinely still-in-flight
one skips the adapter for that run. The mechanism, its state machine, and
`MERIDIAN_KEEPER_SUBMISSION_TTL_MS` are documented in full in
[Migration Keeper](./migration-keeper.md#cross-invocation-duplicate-protection);
this keeper uses exactly the same code path, deliberately, so both keepers'
execution model is the same thing to reason about.

Two things differ, both following from what a duplicate `accrue()` actually
costs: it re-syncs a cached value from the adapter's live position and
produces the same result however many times it lands, so at most one extra
Soroban fee, never incorrect accounting.

- **Fallback.** Where the migration keeper refuses to run on a deployment
  without a shared store, this keeper falls back to a per-invocation one and
  keeps running. On a deployed environment that fallback is logged as a
  warning, not an info line: it reinstates the duplicate-submission gap, and
  that should be visible to whoever watches these logs.
- **Store outages.** Where the migration keeper skips a vault it cannot
  verify, this keeper proceeds and warns. Halting all accrual for the length
  of a KV outage would leave every vault's TVL/APY stale in order to avoid a
  duplicate that costs a fee. A record that is readable and says "still in
  flight" is still respected; only an unreadable one is proceeded past.

`deps.submitAccrual` is handed the lease's hooks; an injected submitter that
ignores them loses cross-invocation dedup, and the run warns at startup when
one is in use.

## Racing The Migration Keeper

Both keepers act on the same vault's adapter independently. This keeper can
read `get_adapter()` at discovery, have the migration keeper switch the vault
to a different adapter before this submission lands, and then call `accrue()`
on the now-detached adapter, which succeeds and does nothing useful (a
detached adapter is still a valid contract, so nothing errors) while the
yield it would have accrued never reaches the vault.

Before building a new `accrue()` transaction, the keeper therefore re-reads
the vault's live `get_adapter()` and skips the adapter if the vault has
already moved on. The next run's discovery picks up the new adapter. The skip
is reported in `skipped[]`, not `failures[]`: it is a benign race, and the
new adapter is accrued on the following tick.
