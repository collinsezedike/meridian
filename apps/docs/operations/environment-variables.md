# Environment Variables

## Web (`apps/web`)

| Variable       | Required | Default | Description                                                                                                                       |
| -------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_URL` | No       | `""`    | Base URL of the API server. Empty means same origin. In local dev, Vite proxies `/api` to `localhost:3001` so this is not needed. |

## API: serverless (`api/v1/`) and Fastify (`apps/api`)

| Variable            | Required | Default                            | Description                                                                                                                                                                                                                                             |
| ------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFINDEX_VAULT_ID` | No       | `""`                               | Overrides the DeFindex vault contract address at runtime. When empty, the address from `CONTRACT_ADDRESSES.testnet.defindex.vault` in `packages/shared/src/constants.ts` is used. Blend and vault contract addresses are always sourced from constants. |
| `PORT`              | No       | `3001`                             | Fastify server port (local dev only).                                                                                                                                                                                                                   |
| `ALLOWED_ORIGIN`    | No       | `"https://usemeridian.vercel.app"` | CORS allowed origin for the Fastify server. Set to your frontend domain in production if running Fastify as a standalone server.                                                                                                                        |

## Vercel

Set environment variables in the Vercel dashboard under **Project Settings > Environment Variables**, or via the CLI:

```bash
vercel env add DEFINDEX_VAULT_ID
```

Variables prefixed with `VITE_` are inlined at build time and exposed to the browser. Do not put secrets in `VITE_` variables.

## Local development

Create `.env` files at the package level if needed:

```bash
# apps/api/.env
PORT=3001
DEFINDEX_VAULT_ID=C...   # optional, leave empty to use the address in constants.ts
```

The Fastify server loads `.env` via the `dotenv` package on startup.

## Future variables

| Variable          | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `STELLAR_NETWORK` | Switch between `testnet` and `mainnet`. Currently hardcoded to testnet. |
| `REDIS_URL`       | If Redis caching is added back to the API layer. Currently not used.    |
