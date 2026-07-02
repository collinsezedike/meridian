# Meridian

**Stablecoin yield aggregator on Stellar, built for emerging market savers.**

Meridian is a savings dashboard that surfaces live USDC yields across [Blend](https://blend.capital) and [DeFindex](https://defindex.io) on the Stellar network and builds the deposit transactions your own wallet signs. Its goal is to route deposits to the highest-yielding vault automatically. It targets users in West Africa and other emerging markets where dollar-denominated savings yield meaningful real returns compared to local currency alternatives.

Submitted to the **Drips Stellar Wave Program**.

---

## Project status

Meridian is a **testnet technical preview**, not a finished product. Be clear-eyed about what exists today before depositing real funds (you can't yet — mainnet is not wired).

**Working today (testnet)**

- Live APY / TVL feed across Stellar stablecoin pools (via DeFiLlama) with a risk heuristic
- Non-custodial signing flow: the API builds an unsigned Soroban XDR, your wallet (Freighter) signs and submits it — keys never leave the browser
- **Direct deposit / withdraw against a real Blend pool**: funds supply straight into Blend from your wallet and the resulting bToken position is yours — no Meridian-controlled custody
- Live position reads from the Blend pool and (when a DeFindex vault is configured) DeFindex vault — current supplied value
- Best-rate routing: the API recommends the highest-APY vault it can actually deposit into, skipping display-only protocols and pools flagged risky
- `MeridianVault` Soroban contract (ERC-4626-style share accounting hardened against the first-depositor inflation attack, pause + admin-rotation rails) with unit tests — reserved for the v2 single-transaction rebalancing router

**In progress — the core promise is not finished**

- Direct deposit/withdraw against real DeFindex vaults — _transaction builders are implemented; gated behind `DEFINDEX_VAULT_ID` until a real testnet vault is wired_
- Per-position yield earned (cost-basis tracking for direct Blend/DeFindex positions)
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
│   ├── api/          # Fastify REST API (local dev): builds Soroban txs, aggregates APY
│   ├── docs/         # Internal architecture and operations docs
│   └── landing/      # Marketing landing page
├── packages/
│   ├── stellar-sdk-helpers/  # Blend & DeFindex client wrappers
│   ├── shared/               # Zod schemas, constants, pure utils
│   └── contracts/            # Soroban smart contracts (Rust)
└── scripts/          # Deploy helpers for testnet / mainnet
```

This is a **pnpm + Turborepo** monorepo. All packages are TypeScript-first with strict mode enabled.

### Data flow

```text
User browser
  └─► Vite + React frontend
        └─► Vercel Serverless Functions (builds unsigned XDR)
              ├─► Blend Protocol (pool data + deposit tx)
              └─► DeFindex Protocol (vault data + deposit tx)
                        │
                   Stellar RPC (Soroban)
```

In production, API routes are Vercel serverless functions (`api/v1/...`). The Fastify server in `apps/api` is used for local development only.

The API never holds private keys. It builds an unsigned Soroban transaction, returns the XDR, and the frontend forwards it to the user's wallet (Freighter) for signing and submission. See [`docs/signing-flow.md`](docs/signing-flow.md) for the full sequence diagram and endpoint reference.

---

## Tech Stack

| Layer           | Technology                                              |
| --------------- | ------------------------------------------------------- |
| Frontend        | Vite 8, React 19, Tailwind CSS, Zustand, TanStack Query |
| Backend (prod)  | Vercel Serverless Functions, Zod validation             |
| Backend (local) | Fastify                                                 |
| Blockchain      | Stellar Soroban, `@stellar/stellar-sdk` v12             |
| Protocols       | Blend Capital, DeFindex                                 |
| Contracts       | Rust / Soroban SDK                                      |
| Monorepo        | pnpm workspaces, Turborepo                              |
| CI              | GitHub Actions                                          |

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`npm i -g pnpm`)
- Rust + `wasm32-unknown-unknown` target (for contracts)
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

### Q2 2026: Deposit, withdraw and earn (testnet)

Non-custodial USDC deposits into Blend and DeFindex vaults on Stellar testnet. Freighter wallet connects in one click, the best-rate vault is selected automatically, and the signed transaction never leaves the browser. Live APY and TVL across protocols with risk-tier labelling. Withdraw at any time, no lock-up.

### Q3 2026: Yield tracking and position history

Per-position yield tracking with a cost-basis model so users see their actual earnings, not just current balance. A yield history chart broken down by protocol, entry time, and cumulative earned. Position-level analytics that work whether funds are in Blend, DeFindex, or split across both.

### Q4 2026: Atomic rebalancing

A Soroban router contract that rebalances between vaults in one atomic transaction. No manual withdraw-then-deposit cycle: when a better rate appears, funds move in a single ledger close. Auto-rebalancing triggers with user-defined APY thresholds. The groundwork for supporting new protocols without UI changes.

### Q1 2027: Mainnet and scale

Third-party security audit, mainnet deployment, and a production-grade rate-limit and caching layer that handles real user load. French and English localisation to open the product to West African users who are not comfortable in English. Mobile-first UI pass targeting low-end Android devices common in the target market.

---

## License

MIT
