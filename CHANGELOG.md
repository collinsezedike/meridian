# Changelog

All notable changes to Meridian will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **MeridianVault: per-user deposit entry time.** The contract now stamps
  `env.ledger().timestamp()` on a user's first deposit (top-ups keep the original;
  a full withdrawal clears it) and exposes it via `get_entry_time`. The
  `/api/v1/positions` endpoint (and the local Fastify route) now return the real
  `entryTime` instead of the previous hardcoded `0`. Covered by
  `deposit_records_entry_time`, `topup_keeps_original_entry_time`,
  `full_withdraw_clears_entry_time`, and `entry_time_defaults_to_zero`.

### Security

- **MeridianVault: add admin safety rails.** New `set_paused`/`is_paused` emergency
  switch halts deposits during an incident, while withdrawals stay open so a pause can
  never trap user funds. Added `set_admin`/`get_admin` for admin key rotation without
  redeploying. Covered by `paused_blocks_deposit`, `withdraw_works_while_paused`,
  `unpause_re_enables_deposits`, and `set_admin_rotates_admin`.
- **MeridianVault: fix first-depositor share inflation attack.** Share price is now
  computed against a virtual shares/assets offset (OpenZeppelin ERC-4626 mitigation)
  instead of the raw on-chain USDC balance, so an attacker can no longer donate USDC
  directly to the contract to skim later depositors via rounding. Added the
  `inflation_attack_is_unprofitable` regression test.

### Tested

- **Unit-test the deposit money-math.** Exported and covered `toStroops` (decimal
  USDC → 7-decimal stroops, incl. sub-unit precision and truncation behaviour) and
  `resolveProtocol` in `stellar-sdk-helpers` — previously untested code on the path
  that determines on-chain deposit amounts.

### Changed

- **`/api/v1/vaults`: cache at the CDN edge.** Added `Cache-Control:
s-maxage=60, stale-while-revalidate=300` so the aggregated vault list is served
  from Vercel's edge — cutting DeFiLlama call volume and letting the edge keep
  serving the last good payload through a transient DeFiLlama outage instead of
  failing the dashboard.

### CI

- Re-enabled the Soroban contract job (`cargo test` + wasm release build) now that
  `packages/contracts` has a `Cargo.toml`.
- Typecheck the Vercel serverless functions in `api/` (new `pnpm typecheck:api`).
  They live outside the pnpm workspace and were previously never typechecked in CI.

### Planned

- Freighter wallet adapter integration
- Live Blend Capital pool APY and TVL data
- Live DeFindex vault APY and TVL data
- APY aggregation API endpoint with Redis caching
- Unsigned Soroban deposit/withdraw transaction XDR builder
- Soroban router contract for atomic single-transaction rebalancing
- Yield history sparkline chart per vault
- French/English i18n with `react-i18next` and locale detection

---

## [0.1.0] - 2026-05-09

### Added

#### Infrastructure

- `pnpm` + Turborepo monorepo with `apps/web`, `apps/api`, `packages/shared`, `packages/stellar-sdk-helpers`, `packages/contracts`
- `pnpm-workspace.yaml` for correct pnpm workspace resolution
- Root `tsconfig.json` extended by all packages
- GitHub Actions CI workflow: lint, typecheck, and test across all packages
- ESLint with `@typescript-eslint` strict rules for web and API
- Dependabot configuration for npm and GitHub Actions dependencies
- `CONTRIBUTING.md` with branch naming, commit convention, and PR process
- `PULL_REQUEST_TEMPLATE.md` with type-of-change checklist and protocol context fields

#### Frontend (`apps/web`)

- Vite + React 18 frontend (migrated from Next.js 14)
- Tailwind CSS with PostCSS — dark theme palette
- `WalletConnect` component (placeholder, Freighter integration pending)
- `VaultCard` component — displays APY, TVL, asset, and protocol badge
- `VaultList` — renders 4 mock vaults (USDC/EURC across Blend and DeFindex)
- `PortfolioSummary` — total deposited, total earned, and per-position breakdown with mock data
- Zustand wallet store (`useWalletStore`)
- `apps/web/src/lib/api.ts` — typed `apiFetch` wrapper using `VITE_API_URL`

#### API (`apps/api`)

- Fastify 4 API skeleton with CORS and rate-limiting plugins
- `GET /api/v1/vaults` — stub returning empty vault list
- `GET /api/v1/vaults/:id` — stub returning 404
- `POST /api/v1/tx/deposit` — validates body with Zod; returns 501 pending implementation
- `POST /api/v1/tx/withdraw` — validates body with Zod; returns 501 pending implementation
- `GET /health` — liveness endpoint

#### SDK (`packages/stellar-sdk-helpers`)

- `getBlendPoolInfo(config)` — stub; decodes Blend pool APY + TVL (implementation pending)
- `buildBlendDepositTx(config, depositor, amount)` — stub; builds unsigned Soroban XDR (pending)
- `getDefindexVaultInfo(config)` — stub; decodes DeFindex vault APY + TVL (pending)
- `buildDefindexDepositTx(config, depositor, amount)` — stub; builds unsigned Soroban XDR (pending)
- `buildHorizonServer(config)` — returns a configured `Horizon.Server`
- `getAccountBalances(server, publicKey)` — fetches all balances for a Stellar account

#### Shared (`packages/shared`)

- `DepositRequestSchema` and `WithdrawRequestSchema` — Zod schemas shared by API and frontend
- `SUPPORTED_STABLECOINS`, `PROTOCOL_IDS`, `CONTRACT_ADDRESSES`, `STELLAR_NETWORKS` constants
- `formatUsdAmount(stroops)` — formats a bigint stroops value to a USD string
- `parseUsdAmount(display)` — parses a USD display string to bigint stroops
- `fromStroops(stroops)` — converts stroops bigint to a JavaScript number
- `shortenAddress(address)` — truncates a Stellar G-address for display

#### Contracts (`packages/contracts`)

- Package scaffold for Soroban Rust contracts (no Cargo.toml yet — pending)
- `scripts/deploy-testnet.sh` — placeholder deploy script for testnet

### Changed

- N/A — initial release

### Fixed

- N/A — initial release

---

[Unreleased]: https://github.com/drydocs/meridian/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/drydocs/meridian/releases/tag/v0.1.0
