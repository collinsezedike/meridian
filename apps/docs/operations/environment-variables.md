# Environment Variables

## Web (`apps/web`)

| Variable       | Required | Default | Description                                                                                                                       |
| -------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_URL` | No       | `""`    | Base URL of the API server. Empty means same origin. In local dev, Vite proxies `/api` to `localhost:3001` so this is not needed. |

## API: serverless (`api/v1/`) and Fastify (`apps/api-local`)

| Variable            | Required | Default                            | Description                                                                                                                                                                                                                                             |
| ------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_NETWORK`   | No       | `"testnet"`                        | Selects the network the API talks to. Any value other than `"mainnet"` resolves to testnet. Controls which `CONTRACT_ADDRESSES`/`STELLAR_NETWORKS` entry (`packages/shared/src/constants.ts`) is used for every contract call the API makes.            |
| `DEFINDEX_VAULT_ID` | No       | `""`                               | Overrides the DeFindex vault contract address at runtime. When empty, the address from `CONTRACT_ADDRESSES.testnet.defindex.vault` in `packages/shared/src/constants.ts` is used. Blend and vault contract addresses are always sourced from constants. |
| `PORT`              | No       | `3001`                             | Fastify server port (local dev only).                                                                                                                                                                                                                   |
| `ALLOWED_ORIGIN`    | No       | `"https://usemeridian.vercel.app"` | CORS allowed origin for the Fastify server. Set to your frontend domain in production if running Fastify as a standalone server.                                                                                                                        |

## Deploy scripts (`scripts/`)

These are shell environment variables read by `scripts/deploy-testnet.sh` and `scripts/redeploy-blend-adapter.sh` at deploy time, not application runtime variables, and not read from `.env` files.

| Variable        | Required                               | Description                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOYER`      | Yes (both scripts)                     | A funded Stellar secret key. Pays transaction fees and signs setup calls only — disposable, does not need to be kept after the script finishes.                                                                                                 |
| `ADMIN`         | No (`deploy-testnet.sh` only)          | A public key that becomes the deployed vault's permanent admin. Defaults to `DEPLOYER`'s own address if unset (with a warning) — set explicitly to a separate, durable key for anything beyond a throwaway test, and required ahead of mainnet. |
| `USDC_ID`       | No                                     | Overrides the testnet USDC contract address the deployed adapter/vault is wired to.                                                                                                                                                             |
| `BLEND_POOL_ID` | No                                     | Overrides the testnet Blend pool address the deployed `BlendAdapter` is wired to.                                                                                                                                                               |
| `VAULT_ID`      | Yes (`redeploy-blend-adapter.sh` only) | The already-live vault contract ID to eventually point at the newly deployed adapter via `set_adapter`.                                                                                                                                         |

`deploy-testnet.sh` prints four contract IDs on success (`VAULT_CONTRACT_ID`, `ROUTER_CONTRACT_ID`, `BLEND_ADAPTER_CONTRACT_ID`, `MUSDC_CONTRACT_ID`) — these aren't environment variables the app reads either; `VAULT_CONTRACT_ID` and `MUSDC_CONTRACT_ID` need to be copied into `CONTRACT_ADDRESSES`/`KNOWN_POOLS` in `packages/shared/src/constants.ts` and `packages/stellar-sdk-helpers/src/known-pools.ts` respectively. See [Testnet Deployment](./testnet-deployment.md).

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

## Future variables

| Variable    | Purpose                                                              |
| ----------- | -------------------------------------------------------------------- |
| `REDIS_URL` | If Redis caching is added back to the API layer. Currently not used. |
