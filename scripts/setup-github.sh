#!/usr/bin/env bash
# =============================================================================
# Meridian — GitHub repository setup script
# Run after: gh auth login
# Usage: bash scripts/setup-github.sh
# =============================================================================
set -euo pipefail

REPO="collinsezedike/meridian"

echo "==> Setting up labels..."

# Stellar Wave label (required for Wave program visibility)
gh label create "Stellar Wave" \
  --repo "$REPO" \
  --color "#0075ca" \
  --description "Eligible for Drips Stellar Wave Program rewards" 2>/dev/null || \
  gh label edit "Stellar Wave" --repo "$REPO" --color "#0075ca" \
  --description "Eligible for Drips Stellar Wave Program rewards"

# Complexity labels
gh label create "medium" \
  --repo "$REPO" \
  --color "#e4e669" \
  --description "Requires familiarity with the Meridian codebase or relevant tooling; expect 4-8 hours" 2>/dev/null || true

gh label create "hard" \
  --repo "$REPO" \
  --color "#d93f0b" \
  --description "Complex implementation spanning multiple packages or involving Soroban contracts" 2>/dev/null || true

# Category labels
gh label create "frontend" \
  --repo "$REPO" \
  --color "#bfd4f2" \
  --description "Involves React components, Tailwind styling, or Vite components" 2>/dev/null || true

gh label create "api" \
  --repo "$REPO" \
  --color "#c2e0c6" \
  --description "Adds or modifies a REST endpoint in apps/api" 2>/dev/null || true

gh label create "sdk" \
  --repo "$REPO" \
  --color "#d4c5f9" \
  --description "Involves Blend or DeFindex SDK helpers in packages/stellar-sdk-helpers" 2>/dev/null || true

gh label create "contracts" \
  --repo "$REPO" \
  --color "#e99695" \
  --description "Involves writing or testing Rust/Soroban contracts in packages/contracts" 2>/dev/null || true

gh label create "stellar" \
  --repo "$REPO" \
  --color "#0052cc" \
  --description "Requires knowledge of Stellar concepts (accounts, transactions, assets)" 2>/dev/null || true

gh label create "soroban" \
  --repo "$REPO" \
  --color "#5319e7" \
  --description "Involves Soroban smart contract invocations or Soroban RPC calls" 2>/dev/null || true

gh label create "ui" \
  --repo "$REPO" \
  --color "#f9d0c4" \
  --description "Purely presentational work — layout, spacing, visual polish" 2>/dev/null || true

gh label create "testing" \
  --repo "$REPO" \
  --color "#0e8a16" \
  --description "Adds or improves test coverage (unit, integration, or e2e)" 2>/dev/null || true

gh label create "ci" \
  --repo "$REPO" \
  --color "#666666" \
  --description "GitHub Actions workflows, CI configuration, or automation" 2>/dev/null || true

gh label create "security" \
  --repo "$REPO" \
  --color "#ee0701" \
  --description "Security hardening, vulnerability fixes, or audit-related work" 2>/dev/null || true

gh label create "docs" \
  --repo "$REPO" \
  --color "#0075ca" \
  --description "Documentation — guides, README, inline docs, or ADRs" 2>/dev/null || true

gh label create "i18n" \
  --repo "$REPO" \
  --color "#fef2c0" \
  --description "Internationalization, locale detection, or translation files" 2>/dev/null || true

gh label create "data-viz" \
  --repo "$REPO" \
  --color "#c5def5" \
  --description "Charting or graphing user-facing data (Recharts)" 2>/dev/null || true

gh label create "protocol-integration" \
  --repo "$REPO" \
  --color "#7057ff" \
  --description "Involves reading from or writing to Blend or DeFindex on-chain" 2>/dev/null || true

echo "==> Labels created."

# =============================================================================
# Rename existing issues
# Check current titles first: gh issue list --repo "$REPO"
# =============================================================================
echo "==> Renaming existing issues..."

# Issue #1 — update title to match [Category] format based on its content
# gh issue edit 1 --repo "$REPO" --title "[Frontend] <current title here>"

# Issue #2 — Vite migration (may already be closed via PR #3)
gh issue edit 2 --repo "$REPO" \
  --title "[Frontend] Migrate frontend from Next.js to Vite + React" 2>/dev/null || true

echo "==> Existing issues renamed."

# =============================================================================
# Create 13 new issues
# =============================================================================
echo "==> Creating new issues..."

# --- TRIVIAL / good first issue ---

gh issue create \
  --repo "$REPO" \
  --title "[Frontend] Add mobile-responsive layout to dashboard" \
  --label "good first issue,Stellar Wave,frontend,ui" \
  --body "## Problem

The dashboard currently uses a desktop-first layout. Many of our target users in West Africa access the web on mobile devices (375–430px viewport width).

## Location in codebase

- \`apps/web/src/components/dashboard/VaultList.tsx\`
- \`apps/web/src/components/dashboard/VaultCard.tsx\`
- \`apps/web/src/components/dashboard/PortfolioSummary.tsx\`
- \`apps/web/src/pages/index.tsx\`

## Tasks

- [ ] VaultCard stack vertically on screens < 640px (use \`grid-cols-1 sm:grid-cols-2\`)
- [ ] Header nav collapses gracefully on mobile
- [ ] PortfolioSummary stat cards readable at 375px
- [ ] No horizontal scroll on iPhone SE viewport (375px)

## Acceptance Criteria

- All vault cards visible without horizontal scroll on 375px viewport
- Tested in Chrome DevTools device emulator (iPhone SE, Pixel 5)"

gh issue create \
  --repo "$REPO" \
  --title "[Frontend] Build VaultCard UI component" \
  --label "good first issue,Stellar Wave,frontend,ui" \
  --body "## Problem

\`VaultList\` renders mock vaults but the \`VaultCard\` component needs to be expanded with richer data display and interaction states.

## Location in codebase

- \`apps/web/src/components/dashboard/VaultCard.tsx\`
- \`apps/web/src/components/dashboard/VaultList.tsx\`

## Tasks

- [ ] Add a loading skeleton state (show when \`vault\` prop is undefined)
- [ ] Add a disabled state for the Deposit button when wallet is not connected
- [ ] Show user's current balance in the vault if \`vault.userBalance > 0n\`
- [ ] Add a tooltip on APY explaining it is an estimate

## Acceptance Criteria

- VaultCard renders correctly with and without a connected wallet
- Deposit button is disabled and shows 'Connect wallet' tooltip when disconnected
- User balance row is hidden when balance is 0"

gh issue create \
  --repo "$REPO" \
  --title "[Docs] Write Blend and DeFindex protocol integration guide" \
  --label "good first issue,Stellar Wave,docs" \
  --body "## Problem

Contributors picking up issues #4 and #5 (Blend and DeFindex SDK implementations) have no internal reference document. They must read third-party documentation and reverse-engineer the integration pattern.

## Location in codebase

- \`docs/\` (create \`docs/protocol-integration.md\`)

## Tasks

- [ ] Explain how Blend stores pool data in Soroban contract storage and how to decode it
- [ ] Explain how DeFindex vault share prices are used to estimate APY
- [ ] Include example RPC calls using \`@stellar/stellar-sdk\`'s \`rpc.Server.getLedgerEntries\`
- [ ] Link to official Blend and DeFindex docs
- [ ] Note known testnet contract addresses (from \`packages/shared/src/constants.ts\`)

## Acceptance Criteria

- A contributor with intermediate Stellar knowledge can implement issue #4 using only this guide and the official protocol docs
- All example code compiles with \`pnpm typecheck\`"

gh issue create \
  --repo "$REPO" \
  --title "[Testing] Add unit tests for @meridian/shared utility functions" \
  --label "good first issue,Stellar Wave,testing" \
  --body "## Problem

\`packages/shared/src/utils.ts\` contains \`formatUsdAmount\`, \`parseUsdAmount\`, \`fromStroops\`, and \`shortenAddress\` — all used across the frontend and API with no test coverage.

## Location in codebase

- \`packages/shared/src/utils.ts\`
- \`packages/shared/src/utils.test.ts\` (create)

## Tasks

- [ ] Add \`vitest\` to \`packages/shared\` devDependencies
- [ ] Add a \`test\` script: \`vitest run --passWithNoTests\`
- [ ] Write tests for \`formatUsdAmount\` — zero, typical, large values, decimal edge cases
- [ ] Write tests for \`parseUsdAmount\` — round-trip with \`formatUsdAmount\`
- [ ] Write tests for \`fromStroops\` — known conversion values
- [ ] Write tests for \`shortenAddress\` — standard G-address, short input

## Acceptance Criteria

- \`pnpm test\` passes with at least 12 assertions covering all four utilities
- Edge cases: zero, max BigInt, address shorter than 8 chars"

# --- MEDIUM ---

gh issue create \
  --repo "$REPO" \
  --title "[Frontend] Implement Freighter wallet adapter" \
  --label "medium,Stellar Wave,frontend,stellar" \
  --body "## Problem

\`WalletConnect\` calls \`connect('PLACEHOLDER_PUBLIC_KEY')\`. No real wallet connection exists. Users cannot authenticate or sign transactions.

## Location in codebase

- \`apps/web/src/components/onboarding/WalletConnect.tsx\`
- \`apps/web/src/lib/wallet.ts\` (create)
- \`apps/web/src/store/wallet.ts\`

## Context

Use \`@stellar/freighter-api\` — the official Freighter browser extension SDK. The API is async and may be unavailable if the extension is not installed.

## Tasks

- [ ] \`pnpm add @stellar/freighter-api\` in \`apps/web\`
- [ ] Detect whether Freighter is installed; render an install prompt if not
- [ ] Call \`getPublicKey()\` and pass to \`useWalletStore().connect()\`
- [ ] Handle user rejection (show inline error, do not crash)
- [ ] Export \`signTransaction(xdr: string): Promise<string>\` from \`apps/web/src/lib/wallet.ts\`
- [ ] Export \`isFreighterInstalled(): Promise<boolean>\` from the same file

## Acceptance Criteria

- Clicking 'Connect Wallet' opens Freighter extension popup
- \`useWalletStore().publicKey\` holds the real G… address after connection
- \`signTransaction\` returns a signed XDR string
- Disconnecting clears the store"

gh issue create \
  --repo "$REPO" \
  --title "[Frontend] Add APY history sparkline chart to VaultCard" \
  --label "medium,Stellar Wave,frontend,data-viz" \
  --body "## Problem

VaultCard shows only the current APY. Users cannot tell whether yield is trending up or down, which affects deposit decisions.

## Location in codebase

- \`apps/web/src/components/dashboard/VaultCard.tsx\`
- \`apps/web/src/components/dashboard/SparklineChart.tsx\` (create)
- \`apps/api/src/routes/vaults.ts\`

## Tasks

- [ ] Add \`GET /api/v1/vaults/:id/history?days=7\` API endpoint
- [ ] Store APY snapshots in Redis sorted set (\`ZADD\` by timestamp) on each aggregator refresh
- [ ] Return \`{ points: { timestamp: number; apy: number }[] }\`
- [ ] Create \`<SparklineChart />\` using Recharts \`<LineChart>\` with no axes, no legend
- [ ] Render sparkline below the APY number in \`VaultCard\`
- [ ] Show 'No history yet' gracefully when fewer than 2 data points exist

## Acceptance Criteria

- Chart renders with ≥ 2 data points without errors
- Graceful empty state when history is absent
- Chart is purely decorative (no tooltip required)"

gh issue create \
  --repo "$REPO" \
  --title "[Frontend] Add French and English i18n with locale detection" \
  --label "medium,Stellar Wave,frontend,i18n" \
  --body "## Problem

Meridian targets West Africa — a region with both English (Nigeria, Ghana) and French (Senegal, Côte d'Ivoire) speakers. The UI is English-only today.

## Location in codebase

- \`apps/web/src/\`
- \`apps/web/messages/\` (create \`en.json\`, \`fr.json\`)

## Context

Use \`react-i18next\` or \`i18next\`. Prefer human-reviewed translations for financial terminology: 'rendement annuel' for APY, 'solde' for balance, 'déposer' for deposit.

## Tasks

- [ ] Install and configure i18n library with locale detection from \`navigator.language\`
- [ ] Create \`apps/web/messages/en.json\` and \`apps/web/messages/fr.json\`
- [ ] Replace all hardcoded UI strings with translation keys
- [ ] Add EN / FR toggle to the header; persist to \`localStorage\`
- [ ] Verify number formatting respects locale (e.g. 12.5% vs 12,5 %)

## Acceptance Criteria

- All user-facing strings translated in both locales
- No English strings visible when locale is \`fr\`
- Language toggle persists selection across page refreshes"

gh issue create \
  --repo "$REPO" \
  --title "[API] Build APY aggregation endpoint with Redis caching" \
  --label "medium,Stellar Wave,api,protocol-integration" \
  --body "## Problem

\`GET /api/v1/vaults\` returns an empty array. There is no live data from either Blend or DeFindex.

## Location in codebase

- \`apps/api/src/routes/vaults.ts\`
- \`apps/api/src/services/vaultAggregator.ts\` (create)

## Context

Depends on issues #4 (Blend fetcher) and #5 (DeFindex fetcher) being implemented first. The aggregator should call both in parallel and merge results. Cache the response in Redis for 60 seconds to avoid hammering Soroban RPC.

## Tasks

- [ ] Create \`apps/api/src/services/vaultAggregator.ts\`
- [ ] Call \`getBlendPoolInfo\` and \`getDefindexVaultInfo\` via \`Promise.all\`
- [ ] Map results to the shared \`VaultInfo\` schema
- [ ] Cache aggregated result with 60s TTL in Redis
- [ ] Return \`{ vaults: VaultInfo[]; updatedAt: string; cached: boolean }\`
- [ ] \`GET /api/v1/vaults/:id\` returns single vault or 404

## Acceptance Criteria

- Endpoint returns at least one vault with non-zero APY on Stellar testnet
- Second request within 60s returns \`cached: true\`
- Handles RPC timeout gracefully (return stale cache or 503, not 500)"

gh issue create \
  --repo "$REPO" \
  --title "[SDK] Implement Blend Capital pool APY and TVL fetcher" \
  --label "medium,Stellar Wave,sdk,stellar,soroban,protocol-integration" \
  --body "## Problem

\`getBlendPoolInfo()\` in \`packages/stellar-sdk-helpers/src/blend.ts\` throws \`Not implemented\`. No live Blend data flows into the app.

## Location in codebase

- \`packages/stellar-sdk-helpers/src/blend.ts\`

## Context

Blend stores pool state in Soroban contract storage. Use the Soroban RPC \`getLedgerEntries\` method via \`rpc.Server\` from \`@stellar/stellar-sdk\`. The relevant data keys are documented at https://docs.blend.capital/tech-docs/core-contracts/lending-pool/pool-state. APY is derived from the interest rate model parameters and utilization rate.

Network: Stellar **testnet**. Testnet pool address is in \`packages/shared/src/constants.ts\`.

## Tasks

- [ ] Decode Blend pool reserve data for the USDC testnet pool
- [ ] Calculate supply APY from \`ir_params\` and current utilization
- [ ] Calculate TVL from total supplied balance (in stroops)
- [ ] Return \`{ apy: number; tvl: bigint }\` matching \`VaultInfo\`
- [ ] Unit test with a recorded RPC response fixture (no live network in CI)

## Acceptance Criteria

- \`getBlendPoolInfo()\` returns non-zero APY and TVL for the USDC testnet pool
- Unit test passes in CI without network access (use fixture)"

gh issue create \
  --repo "$REPO" \
  --title "[SDK] Implement DeFindex vault APY and TVL fetcher" \
  --label "medium,Stellar Wave,sdk,stellar,soroban,protocol-integration" \
  --body "## Problem

\`getDefindexVaultInfo()\` in \`packages/stellar-sdk-helpers/src/defindex.ts\` throws \`Not implemented\`. No live DeFindex data flows into the app.

## Location in codebase

- \`packages/stellar-sdk-helpers/src/defindex.ts\`

## Context

DeFindex vaults expose a \`get_vault_info\` contract function returning total assets and total shares. APY must be estimated from share-price delta over time (fetch current and 24h-ago share prices via stored checkpoints or event history). If no history is available, return APY as 0. Docs: https://docs.defindex.io. Testnet factory address is in \`packages/shared/src/constants.ts\`.

## Tasks

- [ ] Call \`get_vault_info\` on the DeFindex factory contract (testnet)
- [ ] Derive TVL from \`total_assets\`
- [ ] Estimate 24h APY from share-price delta; return 0 if no history
- [ ] Unit test with recorded RPC fixture

## Acceptance Criteria

- \`getDefindexVaultInfo()\` returns TVL for at least one testnet vault
- APY returns 0 gracefully when share-price history is absent
- Unit test passes in CI without network access"

# --- HARD ---

gh issue create \
  --repo "$REPO" \
  --title "[API] Build unsigned Soroban deposit and withdraw transaction XDR" \
  --label "hard,Stellar Wave,api,stellar,soroban" \
  --body "## Problem

\`POST /api/v1/tx/deposit\` and \`POST /api/v1/tx/withdraw\` return 501. Users cannot deposit or withdraw funds.

## Location in codebase

- \`apps/api/src/routes/tx.ts\`
- \`packages/stellar-sdk-helpers/src/blend.ts\` (\`buildBlendDepositTx\`)
- \`packages/stellar-sdk-helpers/src/defindex.ts\` (\`buildDefindexDepositTx\`)

## Context

The API must **never hold private keys**. Build an unsigned Soroban \`invokeHostFunction\` transaction using \`TransactionBuilder\` + \`Operation.invokeHostFunction\`, simulate it via \`rpc.Server.simulateTransaction\` to populate the resource footprint, and return the base64-encoded XDR. The frontend passes this to Freighter for signing and submission.

## Tasks

- [ ] Resolve vault ID to protocol and contract address
- [ ] Build \`invokeHostFunction\` operation calling \`deposit(depositor, amount)\`
- [ ] Simulate transaction to populate resource fee
- [ ] Return \`{ xdr: string; fee: string }\` from the endpoint
- [ ] Implement withdraw XDR builder symmetrically
- [ ] Integration test against Stellar testnet (skip in offline CI via env flag \`SKIP_NETWORK_TESTS=1\`)

## Acceptance Criteria

- Returned XDR decodes and submits successfully after Freighter signing on testnet
- Invalid wallet address or amount returns 400 with clear error message
- Simulated fee is included in the response"

gh issue create \
  --repo "$REPO" \
  --title "[Security] Harden API rate limiting, input validation, and CSP headers" \
  --label "hard,Stellar Wave,security,api" \
  --body "## Problem

The API has basic rate limiting via \`@fastify/rate-limit\` but no per-route limits, no request size caps, and no Content Security Policy headers on the frontend. For a DeFi app handling real funds, this surface needs hardening.

## Location in codebase

- \`apps/api/src/index.ts\`
- \`apps/api/src/middleware/\` (create)
- \`apps/web/vite.config.ts\` or reverse proxy config

## Tasks

- [ ] Add per-route rate limits: \`/tx/deposit\` and \`/tx/withdraw\` max 10 req/min per IP
- [ ] Add request body size limit (max 10KB) to prevent oversized payload attacks
- [ ] Validate Stellar G-address format with a regex guard before passing to SDK
- [ ] Add \`X-Content-Type-Options: nosniff\` and \`X-Frame-Options: DENY\` response headers
- [ ] Document all limits in a comment at the top of \`apps/api/src/index.ts\`
- [ ] Add a test asserting rate limit returns 429 after threshold

## Acceptance Criteria

- \`/tx/deposit\` returns 429 after 10 requests/min from the same IP
- Oversized body returns 413
- Invalid Stellar address format returns 400 before any RPC call is made
- Security headers present on all API responses"

echo "==> 13 new issues created."

# =============================================================================
# Enable GitHub Discussions via API
# Requires: gh auth login with repo + admin:org scope
# If this fails, enable manually: Settings > Features > Discussions
# =============================================================================
echo "==> Enabling GitHub Discussions..."

REPO_ID=$(gh api graphql \
  -f query='query { repository(owner: "collinsezedike", name: "meridian") { id } }' \
  --jq '.data.repository.id' 2>/dev/null || echo "")

if [ -n "$REPO_ID" ]; then
  gh api graphql \
    -f query="mutation { updateRepository(input: { repositoryId: \"$REPO_ID\", hasDiscussionsEnabled: true }) { repository { hasDiscussionsEnabled } } }" \
    2>/dev/null && echo "Discussions enabled." || \
    echo "Could not enable Discussions via API. Enable manually: Settings > Features > Discussions."
else
  echo "Could not fetch repo ID. Enable Discussions manually: Settings > Features > Discussions."
fi

echo ""
echo "==> Setup complete."
echo ""
echo "Next steps:"
echo "  1. Check issue #1's current title and run:"
echo "     gh issue edit 1 --repo $REPO --title '[Category] Title'"
echo "  2. Enable Discussions manually if the API call above failed."
echo "  3. Pin a welcome Discussion post in the Q&A category."
