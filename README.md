# Meridian

**Stablecoin yield aggregator on Stellar, built for emerging market savers.**

Meridian is a savings dashboard that surfaces live USDC yields across [Blend](https://blend.capital) and [DeFindex](https://defindex.io) on the Stellar network and builds the deposit transactions your own wallet signs. Its goal is to route deposits to the highest-yielding vault automatically. It targets users in West Africa and other emerging markets where dollar-denominated savings yield meaningful real returns compared to local currency alternatives.

Submitted to the **Drips Stellar Wave Program**.

---

## Project status

Meridian is a **testnet technical preview**, not a finished product. Be clear-eyed about what exists today before depositing real funds (you can't yet — mainnet is not wired).

**Working today (testnet)**

- Live APY / TVL feed across Stellar stablecoin pools (via DeFiLlama on mainnet; direct on-chain queries on testnet, since DeFiLlama doesn't index it) with a risk heuristic
- Non-custodial signing flow: the API builds an unsigned Soroban XDR, your wallet (Freighter) signs and submits it — keys never leave the browser
- **Deposit / withdraw through the live `MeridianVault` coordinator contract**: the vault forwards your USDC to its active adapter contract (`BlendAdapter` today), which supplies it straight into a real Blend pool — you receive mUSDC shares representing the position, no Meridian-controlled custody of the underlying funds
- Live TVL and per-address position reads directly from the vault (`get_total_assets`, `get_position`)
- Best-rate routing: the API recommends the highest-APY vault it can actually deposit into, skipping display-only protocols and pools flagged risky
- Protocol-agnostic adapter architecture: `MeridianVault` (ERC-4626-style share accounting hardened against the first-depositor inflation attack, pause + admin-rotation rails), `BlendAdapter` (live), and a `DefindexAdapter` contract (built, not yet wired to a live vault) — swapping which protocol a vault routes to is an admin-only `set_adapter` call, no vault redeploy required. The vault's `migrate_adapter` entry point atomically moves the vault's entire position to a new adapter in one slippage-bounded transaction, no manual withdraw-then-deposit cycle, and no per-user signature needed since it operates on the vault's aggregate position, not individual depositor balances. All three contracts have unit test coverage.
- Per-position yield earned: cost-basis tracking via `get_principal`, surfaced in the dashboard alongside the current position value

**In progress — the core promise is not finished**

- Deposit/withdraw against a real DeFindex vault through `DefindexAdapter` — the adapter contract and transaction builders are implemented; gated behind `DEFINDEX_VAULT_ID` until a real testnet vault is wired
- Mainnet configuration and a security audit before any real-funds use

Until a DeFindex vault is configured, the DeFindex deposit path throws a configuration error rather than silently routing elsewhere. Track progress in the [Roadmap](#roadmap) and [open issues](../../issues).

---

## Why Meridian?

Inflation in many West African economies regularly exceeds 20 % annually. Access to USD savings accounts is limited by KYC friction and minimum balances. Stellar's low fees (< $0.01/tx), fast finality (5s), and USDC availability make it an ideal rails layer. Meridian removes the final UX barrier: users connect a wallet, see live APY across protocols, and deposit in three clicks.

---

## Architecture

```text
meridian/
├── apps/
│   ├── web/          # Vite + React 19 dashboard (TypeScript, Tailwind, Zustand)
│   ├── api-local/    # Fastify REST API (local dev only): builds Soroban txs, aggregates APY
│   ├── docs/         # Internal architecture and operations docs
│   └── landing/      # Marketing landing page
├── api/              # Vercel serverless functions (api/v1/...) — the production API
├── packages/
│   ├── api-core/             # Framework-agnostic route handlers shared by both servers
│   ├── stellar-sdk-helpers/  # Blend & DeFindex client wrappers
│   ├── shared/               # Zod schemas, constants, pure utils
│   └── contracts/            # Soroban smart contracts (Rust): vault, blend-adapter, defindex-adapter
└── scripts/          # deploy-testnet.sh (fresh stack), redeploy-blend-adapter.sh (swap adapter on a live vault)
```

This is a **pnpm + Turborepo** monorepo. All packages are TypeScript-first with strict mode enabled.

### Data flow

```text
User browser
  └─► Vite + React frontend
        └─► Vercel Serverless Functions (builds unsigned XDR)
              └─► MeridianVault coordinator contract
                    └─► active adapter (BlendAdapter today) ─► underlying protocol pool
                              │
                         Stellar RPC (Soroban)
```

In production, API routes are Vercel serverless functions (`api/v1/...`). The Fastify server in `apps/api-local` is used for local development only.

The API never holds private keys. It builds an unsigned Soroban transaction, returns the XDR, and the frontend forwards it to the user's wallet (Freighter) for signing and submission. See [`docs/signing-flow.md`](docs/signing-flow.md) for the full sequence diagram and endpoint reference.

---

## Tech Stack

| Layer           | Technology                                              |
| --------------- | ------------------------------------------------------- |
| Frontend        | Vite 8, React 19, Tailwind CSS, Zustand, TanStack Query |
| Backend (prod)  | Vercel Serverless Functions, Zod validation             |
| Backend (local) | Fastify                                                 |
| Blockchain      | Stellar Soroban, `@stellar/stellar-sdk` v14             |
| Protocols       | Blend Capital, DeFindex                                 |
| Contracts       | Rust / Soroban SDK                                      |
| Monorepo        | pnpm workspaces, Turborepo                              |
| CI              | GitHub Actions                                          |

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`npm i -g pnpm`)
- Rust + `wasm32v1-none` target (for contracts)
- Stellar CLI (`cargo install stellar-cli`)

### Install

```bash
git clone https://github.com/drydocs/meridian.git
cd meridian
pnpm install
```

### Configure

```bash
cp .env.example .env
# Set DEFINDEX_VAULT_ID if you have a DeFindex vault configured; leave empty otherwise
```

### Run locally

```bash
# Start API + web in parallel
pnpm dev
```

- Web: <http://localhost:3000>
- API: <http://localhost:3001>
- Health: <http://localhost:3001/health>

### Run tests

```bash
pnpm test
```

### Build for production

```bash
pnpm build
```

---

## Protocols

### Blend Capital

Blend is a permission-less lending protocol on Stellar. Meridian reads pool APY from Blend's on-chain pool data entries and builds deposit/withdraw transactions via Soroban contract invocations. See [`packages/stellar-sdk-helpers/src/blend.ts`](packages/stellar-sdk-helpers/src/blend.ts).

### DeFindex

DeFindex is a yield-strategy vault protocol on Stellar that composes multiple yield sources behind a single share token. Meridian treats each DeFindex vault as a single aggregated position. See [`packages/stellar-sdk-helpers/src/defindex.ts`](packages/stellar-sdk-helpers/src/defindex.ts).

---

## Contributing

We welcome contributions. See [open issues](../../issues) for a range of tasks across TypeScript, Rust/Soroban, and UI.

1. Fork the repo and create a feature branch: `git checkout -b feat/your-feature`
2. Follow the existing code style (no comments unless WHY is non-obvious)
3. Run `pnpm lint && pnpm typecheck && pnpm test` before opening a PR
4. Reference the relevant GitHub issue in your PR description

Issues are tagged `good first issue`, `medium`, and `hard`. Pick your level.

---

## Roadmap

### Q2 2026: Deposit, withdraw and earn (testnet) — shipped for Blend

Non-custodial USDC deposits into the `MeridianVault` coordinator contract on Stellar testnet, live and working end-to-end for Blend via `BlendAdapter`. Freighter wallet connects in one click, the best-rate vault is selected automatically, and the signed transaction never leaves the browser. Live APY and TVL across protocols with risk-tier labelling. Withdraw at any time, no lock-up. DeFindex support is built (`DefindexAdapter`) but not yet wired to a live testnet vault.

### Q3 2026: Yield history and position analytics

Per-position yield tracking with a cost-basis model is shipped: users already see cumulative earned alongside their current balance. Remaining: a yield history chart broken down by protocol, entry time, and cumulative earned over time. Position-level analytics that work whether funds are in Blend, DeFindex, or split across both.

### Q4 2026: Automatic yield routing, built but not yet live

A scheduled keeper that compares live rates across a vault's candidate adapters and calls the vault's `migrate_adapter` when a candidate clears a configured improvement threshold is built (see [#469](../../issues/469)): discovery, retry, deadline-budget handling, and slippage/threshold-bounded submission all work and are tested. Two gaps remain before it's actually live: rate comparison itself isn't implemented for either protocol yet ([#511](../../issues/511)), and the live testnet vault predates `migrate_adapter` and needs a fresh deployment before the function is even callable ([#514](../../issues/514)).

### Q1 2027: Mainnet and scale

Third-party security audit, mainnet deployment, and a production-grade rate-limit and caching layer that handles real user load. French and English localisation to open the product to West African users who are not comfortable in English. Mobile-first UI pass targeting low-end Android devices common in the target market.

---

## License

MIT
