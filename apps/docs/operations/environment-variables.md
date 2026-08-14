# Environment Variables

## Web (`apps/web`)

| Variable       | Required | Default | Description                                                                                                                       |
| -------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_URL` | No       | `""`    | Base URL of the API server. Empty means same origin. In local dev, Vite proxies `/api` to `localhost:3001` so this is not needed. |

## API: serverless (`api/v1/`) and Fastify (`apps/api-local`)

| Variable                                 | Required     | Default                            | Description                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_NETWORK`                        | No           | `"testnet"`                        | Selects the network the API talks to. Any value other than `"mainnet"` resolves to testnet. Controls which `CONTRACT_ADDRESSES`/`STELLAR_NETWORKS` entry (`packages/shared/src/constants.ts`) is used for every contract call the API makes.                                                                                                                |
| `DEFINDEX_VAULT_ID`                      | No           | `""`                               | Overrides the DeFindex vault contract address at runtime. When empty, the address from `CONTRACT_ADDRESSES.testnet.defindex.vault` in `packages/shared/src/constants.ts` is used. Blend and vault contract addresses are always sourced from constants.                                                                                                     |
| `PORT`                                   | No           | `3001`                             | Fastify server port (local dev only).                                                                                                                                                                                                                                                                                                                       |
| `ALLOWED_ORIGIN`                         | No           | `"https://usemeridian.vercel.app"` | CORS allowed origin for the Fastify server. Set to your frontend domain in production if running Fastify as a standalone server.                                                                                                                                                                                                                            |
| `REDIS_URL`                              | No           | `""`                               | Redis URL for `@fastify/rate-limit` in `apps/api-local` (ioredis). Unset: in-memory store (single process); production: set for distributed rate limits.                                                                                                                                                                                                    |
| `CRON_SECRET`                            | Yes          | `""`                               | Bearer token required by scheduled keeper endpoints in production and preview deployments. Only true local dev (no `VERCEL_ENV` set) is permissive without it.                                                                                                                                                                                              |
| `MERIDIAN_KEEPER_SECRET_KEY`             | Yes (keeper) | `""`                               | Stellar secret seed for the funded account that submits Blend `accrue()` transactions. Store in a secrets manager or deployment environment variables; never commit it.                                                                                                                                                                                     |
| `MERIDIAN_KEEPER_MAX_ATTEMPTS`           | No           | `3`                                | Maximum attempts per submission. Shared by both the accrue keeper and the migration keeper (`rebalance.ts`), not accrue-specific despite the name; sizing it affects both.                                                                                                                                                                                  |
| `MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS`    | No           | `1000`                             | Initial exponential-backoff delay for transient keeper failures. Shared by both the accrue keeper and the migration keeper.                                                                                                                                                                                                                                 |
| `MERIDIAN_KEEPER_RPC_TIMEOUT_MS`         | No           | `10000`                            | Timeout for keeper RPC calls, in milliseconds. Shared by both the accrue keeper and the migration keeper. Fully governs submission calls; discovery reads are additionally capped at a hardcoded 10s ceiling shared with the rest of `stellar-sdk-helpers`, so values above `10000` only extend the submission side.                                        |
| `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY`   | Yes (keeper) | `""`                               | Stellar secret seed for the migration keeper. Must be the vault's actual admin address; `migrate_adapter` is admin-gated, unlike the permissionless `accrue()`, so this key carries full vault admin authority. Deliberately separate from `MERIDIAN_KEEPER_SECRET_KEY`. See `apps/docs/operations/migration-keeper.md`.                                    |
| `MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS`    | No           | `100`                              | `max_slippage_bps` passed to every `migrate_adapter` call. The config loader rejects `10000` (unlimited slippage).                                                                                                                                                                                                                                          |
| `MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS` | No           | `50`                               | Minimum rate improvement, in basis points, a candidate protocol must clear before the keeper migrates to it.                                                                                                                                                                                                                                                |
| `MERIDIAN_ADAPTER_<PROTOCOL>_ID`         | No           | `""`                               | Candidate adapter contract address the migration keeper may migrate the vault to, one var per protocol (e.g. `MERIDIAN_ADAPTER_BLEND_ID`, `MERIDIAN_ADAPTER_DEFINDEX_ID`). Not a fixed list: any `<PROTOCOL>` is picked up automatically, adding a new protocol needs no code change. Unset excludes that protocol from consideration, no fallback default. |

## Deploy scripts (`scripts/`)

These are shell environment variables read by `scripts/deploy-testnet.sh` and `scripts/redeploy-blend-adapter.sh` at deploy time, not application runtime variables, and not read from `.env` files.

| Variable        | Required                               | Description                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOYER`      | Yes (both scripts)                     | A funded Stellar secret key. Pays transaction fees and signs setup calls only — disposable, does not need to be kept after the script finishes.                                                                                                 |
| `ADMIN`         | No (`deploy-testnet.sh` only)          | A public key that becomes the deployed vault's permanent admin. Defaults to `DEPLOYER`'s own address if unset (with a warning) — set explicitly to a separate, durable key for anything beyond a throwaway test, and required ahead of mainnet. |
| `USDC_ID`       | No                                     | Overrides the testnet USDC contract address the deployed adapter/vault is wired to.                                                                                                                                                             |
| `BLEND_POOL_ID` | No                                     | Overrides the testnet Blend pool address the deployed `BlendAdapter` is wired to.                                                                                                                                                               |
| `VAULT_ID`      | Yes (`redeploy-blend-adapter.sh` only) | The already-live vault contract ID to eventually point at the newly deployed adapter via `set_adapter`.                                                                                                                                         |

`deploy-testnet.sh` prints three contract IDs on success (`VAULT_CONTRACT_ID`, `BLEND_ADAPTER_CONTRACT_ID`, `MUSDC_CONTRACT_ID`) — these aren't environment variables the app reads either; `VAULT_CONTRACT_ID` and `MUSDC_CONTRACT_ID` need to be copied into `CONTRACT_ADDRESSES`/`KNOWN_POOLS` in `packages/shared/src/constants.ts` and `packages/stellar-sdk-helpers/src/known-pools.ts` respectively. See [Testnet Deployment](./testnet-deployment.md).

## Vercel

Set environment variables in the Vercel dashboard under **Project Settings > Environment Variables**, or via the CLI:

```bash
vercel env add DEFINDEX_VAULT_ID
```

Variables prefixed with `VITE_` are inlined at build time and exposed to the browser. Do not put secrets in `VITE_` variables.

## Local development

Create `.env` files at the package level if needed:

```bash
# apps/api-local/.env
PORT=3001
DEFINDEX_VAULT_ID=C...   # optional, leave empty to use the address in constants.ts
```

The Fastify server loads `.env` via the `dotenv` package on startup.
