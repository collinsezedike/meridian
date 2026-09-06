# Admin-Event Alert Keeper

The vault emits on-chain events for admin actions: `paused`, `transfer`,
`accept`, `adapter`, and `migrate` (#698). Nothing consumed that feed until
now, so an unexpected pause, an admin-key rotation, or an adapter migration
would only be noticed by whoever happened to check the app. This keeper
watches for those events and posts a webhook alert as soon as one lands.

## Schedule

The same GitHub Actions workflow that runs the other keepers
(`.github/workflows/keepers.yml`) calls `POST /api/v1/keepers/alert` every 5
minutes, authenticating with the same `CRON_SECRET` bearer token as
`accrue`/`rebalance`. See [Blend Accrual Keeper](./accrual-keeper.md#schedule)
for why this lives in GitHub Actions rather than Vercel Cron.

A 5-minute interval is tighter than the accrual keeper's 15 minutes: these are
exactly the actions an operator needs to know about immediately, not on the
same staleness budget as a TVL/APY cache.

## Alert Destination

Set `MERIDIAN_ALERT_WEBHOOK_URL` to a Slack or Discord incoming-webhook URL.
Every alert POSTs a JSON body containing both `text` (Slack's field) and
`content` (Discord's field), so the same configuration works against either
service without picking a payload shape up front; whichever field a service
doesn't recognise is ignored.

## Which Events Alert

Only `paused`, `transfer`, `adapter`, and `migrate` trigger an alert.
`accept_admin` is deliberately excluded: it is the second half of an
already-alerted `transfer_admin` nomination, not a new risk on its own.

## Cursor Tracking

Each known vault (`KNOWN_POOLS` entries with `protocol: "meridian"` and a
`contractId` set for the running network, the same filter the accrual
keeper's discovery uses) has its own last-processed-ledger cursor, stored in
the shared Upstash Redis store under
`meridian:keeper:alert:cursor:<network>:<vaultContractId>`. Every run reads
that cursor, fetches admin events since it via `getRpcAdminHistory`, and
advances the cursor only as far as the last event it actually alerted on (or
that needed no alert, e.g. `accept_admin`). This is the same store
`keeper-heartbeat.ts` uses for last-successful-run timestamps, reused here
for a ledger number instead: both are a last-write-wins value with no
lease/CAS semantics, since the worst a race costs here is a duplicate or
delayed alert, never an incorrect one.

On first run, with no cursor stored yet, the keeper starts from the current
ledger rather than replaying the vault's entire admin history as a flood of
alerts.

If a webhook send fails, the cursor stops advancing past that event, so it
(and anything after it in the same page) is retried on the next scheduled
run instead of being silently skipped. This can produce a duplicate alert
for an event that actually landed but whose HTTP response was lost; it never
loses one.

## Retry And Failure Handling

Configure the same knobs the other keepers share:

- `MERIDIAN_KEEPER_MAX_ATTEMPTS` default `3`
- `MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS` default `1000`
- `MERIDIAN_KEEPER_RPC_TIMEOUT_MS` default `10000` (also used as the webhook
  request timeout)

Failures are logged with the vault id, contract id, stage (`discover` or
`send`), attempt count, and error summary, and included in the endpoint
response. If at least one failure occurs, the endpoint returns HTTP 500 so
the scheduled run is observable instead of silently passing.
