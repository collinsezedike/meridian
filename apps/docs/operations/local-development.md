# Local Development

## Prerequisites

| Tool        | Version | Install                          |
| ----------- | ------- | -------------------------------- |
| Node.js     | ≥ 20    | [nodejs.org](https://nodejs.org) |
| pnpm        | ≥ 9     | `npm i -g pnpm`                  |
| Rust        | stable  | [rustup.rs](https://rustup.rs)   |
| Stellar CLI | latest  | `cargo install stellar-cli`      |

The Rust toolchain and Stellar CLI are only required if you are working on the Soroban contracts in `packages/contracts/`. Frontend and API work does not require them.

## Setup

```bash
git clone https://github.com/drydocs/meridian.git
cd meridian
pnpm install
```

## Running the full stack

```bash
pnpm dev
```

Turborepo starts all `dev` tasks in parallel:

- **Web** at `http://localhost:3000/app/` (Vite dev server with HMR)
- **API** at `http://localhost:3001` (Fastify with `tsx watch`)
- **Docs** at `http://localhost:3000/docs/` (VitePress, proxied from port 3002)

The Vite dev server proxies `/api/*` to `http://localhost:3001` and `/docs/*` to the VitePress dev server at port 3002.

## Running services individually

```bash
# Web only
pnpm --filter @meridian/web dev

# API only
pnpm --filter @meridian/api dev
```

## Health check

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

## Running tests

```bash
pnpm test
```

To run tests for a single package:

```bash
pnpm --filter @meridian/shared test
pnpm --filter @meridian/stellar-sdk-helpers test
```

## Type checking

```bash
pnpm typecheck
```

## Linting

```bash
pnpm lint
```

## Building packages

If you edit a `packages/` library, rebuild it before the apps pick up the changes:

```bash
pnpm build
```

Or build a single package:

```bash
pnpm --filter @meridian/shared build
```

## Working with the vault contract

```bash
cd packages/contracts/vault

# Build the WASM
stellar contract build

# Run Rust tests
cargo test
```

See [Testnet Deployment](./testnet-deployment.md) for deploying the contract to testnet.

## Freighter wallet

Install the [Freighter browser extension](https://freighter.app) and switch it to **Testnet** mode. Fund your testnet account using [Stellar Friendbot](https://friendbot.stellar.org/?addr=YOUR_ADDRESS).

The local API server is hardcoded to testnet (`STELLAR_NETWORKS.testnet`). Mainnet configuration is available via environment variables but is not the default for local development.
