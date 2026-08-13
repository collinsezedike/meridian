# Blend Accrual Keeper

Meridian Blend adapters cache `total_assets()`. Deposits and withdrawals update
that cache, but passive Blend interest is only reflected after a real
`accrue()` transaction lands on-chain. Read-only simulations do not persist
state, so the production deployment runs a scheduled keeper.

## Schedule

Vercel Cron calls `GET /api/v1/keepers/accrue` every 15 minutes, as configured
in `vercel.json`.

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

Set `CRON_SECRET` as a separate secret. Scheduled calls must include
`Authorization: Bearer $CRON_SECRET`; both production and preview deployments
fail closed when `CRON_SECRET` is missing, only true local dev (no
`VERCEL_ENV` at all) is permissive. Unlike simple rate-limit relaxation
elsewhere, this endpoint triggers real signed transactions off the keeper's
funded account, so an unauthenticated preview URL is a real gas-drain risk,
not just a convenience gap.

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
sending a new one, within a single run. This tracking does not persist across
separate keeper invocations: if a run exhausts its retries while a submission
is still unconfirmed, the next scheduled run has no memory of it and may send
a fresh `accrue()` transaction for the same adapter. This is an accepted,
bounded gap rather than a fund-safety issue: `accrue()` only refreshes a
cached value from the adapter's live position and produces the same result no
matter how many times it lands, so a duplicate costs at most one extra
Soroban fee, not incorrect accounting.
