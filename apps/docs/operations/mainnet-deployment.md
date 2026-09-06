# Mainnet Deployment Runbook

> **Status:** Draft. Do not run this against mainnet until all items in the [Go-Live Checklist](#go-live-checklist) are resolved.
>
> For testnet deployments, see [`testnet-deployment.md`](./testnet-deployment.md) instead. This document exists separately because mainnet and testnet have materially different risk profiles — conflating them risks copying a testnet convenience into a mainnet deploy.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Key Custody](#key-custody)
3. [Parameter Selection](#parameter-selection)
4. [Deployment Steps](#deployment-steps)
5. [Rollback / Incident Plan](#rollback--incident-plan)
6. [Go-Live Checklist](#go-live-checklist)

---

## Prerequisites

### 1. Funded Deployer

A mainnet-deployer account must be funded with sufficient XLM to cover:

- Contract upload and deployment transactions (4 contracts: vault, blend-adapter, defindex-adapter, mUSDC-token)
- ~20 XLM reserve for contract rent bumps (TTL extension)
- Buffer for retry transactions

Unlike testnet, there is no Friendbot. Acquire XLM through a supported exchange or on-ramp.

### 2. Durable Admin Key

The vault's `ADMIN` key must be:

- **Separate from `DEPLOYER`** — `DEPLOYER` is a hot key that only pays fees and runs setup scripts. It can be discarded after deploy.
- **Not a throwaway CLI key** — never use `stellar keys generate` for mainnet admin. The admin key controls `set_paused`, `set_adapter`, `migrate_adapter`, and `transfer_admin`.
- **Multisig or hardware-backed strongly preferred** — a single hot key with no timelock or second-party confirmation is a known open risk (see [#557](https://github.com/drydocs/meridian/issues/557)).
- **Backed up in multiple locations** — there is no recovery path if the admin key is lost. `transfer_admin` requires the current admin's signature, so a lost key bricks all admin functions permanently.

### 3. Environment Preparation

- Stellar CLI with `wasm32v1-none` target: `rustup target add wasm32v1-none`
- Verified build of all contract crates from a clean, audited commit
- All contract `.wasm` hashes recorded and cross-checked against the audit report

---

## Key Custody

### Recommended: 2-of-3 Multisig

For mainnet, the vault admin should be a 2-of-3 multisig address rather than a single key. This closes the single-point-of-failure identified in [#557](https://github.com/drydocs/meridian/issues/557) where one compromised or lost key can irreversibly move the vault's entire position.

- **Key 1:** Hardware wallet (Ledger/Trezor) held by the primary operator
- **Key 2:** Hardware wallet held by a secondary operator (different physical location)
- **Key 3:** Cold-storage paper backup held in a secure location (safety deposit box, corporate vault)

### Admin Key Lifecycle

```
Deploy
  |
  v
ADMIN = 2-of-3 multisig address
  |
  +---> transfer_admin(new_admin)  (requires 2-of-3 signatures)
  |       |
  |       v
  |   accept_admin()  (requires new_admin's 2-of-3)
  |
  +---> set_paused(true)  (emergency, requires 2-of-3)
  |
  +---> migrate_adapter(...)  (requires 2-of-3)
```

**Important:** The contract enforces no timelock on admin actions today ([#557](https://github.com/drydocs/meridian/issues/557)). Until that is resolved, the multisig itself is the only delay mechanism: two separate parties must coordinate to sign any admin action.

---

## Parameter Selection

The following parameters are either defaulted on testnet or hardcoded in the contract. Each must be explicitly chosen for mainnet.

### Migration Cooldown (`MIN_LEDGER_GAP`)

| Environment | Value | Rationale |
|-------------|-------|-----------|
| Testnet | 12 ledgers (~1 min) | Fast iteration; low attack surface on testnet |
| **Mainnet** | **120 ledgers (~10 min)** | Sustained manipulation requires ~10 minutes, giving operators and monitoring time to detect and respond |

Set via: contract source constant. Requires re-audit and redeploy to change.

### Slippage Tolerances

| Action | Testnet Default | Mainnet Recommendation |
|--------|-----------------|------------------------|
| `migrate_adapter` | No ceiling (up to 10,000 bps / 100%) | **Hard cap at 500 bps (5%)** enforced off-chain via keeper config; any migration request above this is rejected before submission |
| User deposit | No `min_shares_out` required | UI should calculate and enforce a reasonable floor based on current share price |
| User withdraw | No `min_usdc_out` required | UI should calculate and enforce a reasonable floor |

> **Note:** The contract allows `max_slippage_bps = 10_000` (100%) as a valid, if extreme, value. This is intentional for recovery scenarios (e.g., a known-broken adapter where any migration is better than none), but the keeper and any migration scripts should default to a much tighter bound. See [#557](https://github.com/drydocs/meridian/issues/557).

### TTL Extension Thresholds

| Storage Type | Testnet | Mainnet |
|--------------|---------|---------|
| Instance TTL | 30 days | **30 days** (same; bump on every state-changing call) |
| Position (Entry/Principal) TTL | 120 days | **120 days** |

Mainnet deployments should verify TTL bumping is active and monitor for any contract approaching expiration. The keeper's heartbeat endpoint (`/api/health`) already tracks this.

### Pause Behavior

While paused:
- **Deposits are rejected** — new funds cannot enter
- **Withdrawals remain open** — a pause can never trap user funds

This is contract-level behavior and cannot be changed without redeploy. Verify it with a test pause immediately after deployment.

---

## Deployment Steps

### Step 1: Build from Audited Commit

```bash
git checkout <audited-commit-hash>
cargo build --target wasm32v1-none --release
```

Record the SHA-256 of each `.wasm` artifact and cross-check against the audit report.

### Step 2: Fund Accounts

- Fund `DEPLOYER` with ~50 XLM
- Ensure the 2-of-3 multisig `ADMIN` address is funded (it sources the vault deploy transaction)

### Step 3: Deploy

Adapted from `scripts/deploy-testnet.sh`:

```bash
# DEPLOYER: hot key, pays fees, discarded after deploy
# ADMIN: 2-of-3 multisig address, permanent admin
# ADMIN_KEY: a stellar-cli alias that resolves to one of the multisig signers
#            (the full 2-of-3 transaction must be assembled and signed externally)

DEPLOYER=my-deployer \
ADMIN=<2-of-3-multisig-address> \
bash scripts/deploy-mainnet.sh
```

> **TODO:** `scripts/deploy-mainnet.sh` does not yet exist. Create it by adapting `deploy-testnet.sh` with mainnet network parameters, multisig-aware transaction assembly, and the parameter values from this runbook.

### Step 4: Verify

```bash
stellar contract invoke --network mainnet --source my-deployer \
  --id $VAULT_CONTRACT_ID -- get_total_assets

# Should return 0 for a fresh vault

stellar contract invoke --network mainnet --source my-deployer \
  --id $VAULT_CONTRACT_ID -- get_adapter

# Should return the deployed BlendAdapter ID
```

### Step 5: Update Frontend Config

```typescript
// packages/stellar-sdk-helpers/src/known-pools.ts
KNOWN_POOLS.mainnet["meridian-usdc"].contractId = "..."; // VAULT_CONTRACT_ID

// packages/shared/src/constants.ts
CONTRACT_ADDRESSES.mainnet.vault = "...";
CONTRACT_ADDRESSES.mainnet.musdc = "...";
```

---

## Rollback / Incident Plan

### Contracts Have No In-Place Upgrade Path

Soroban contracts do not support `update_current_contract_wasm()`. Once a contract is deployed, its code is immutable. This is a feature, not a bug — it guarantees that the code users interact with matches the audited artifact — but it means there is no "rollback" in the traditional sense.

### Supported Recovery Paths

#### 1. Adapter Bug (No Depositors Yet)

If a bug is discovered in an adapter **before** the vault has depositors:

```bash
# Deploy a fixed adapter and swap the vault to it
VAULT_ID=$VAULT_CONTRACT_ID DEPLOYER=my-deployer bash scripts/redeploy-blend-adapter.sh
```

This uses `set_adapter`, which is safe when `get_total_shares() == 0`.

#### 2. Adapter Bug (Live Vault with Depositors)

If depositors already exist:

```bash
# Phase 1: Begin migration snapshot
stellar contract invoke --network mainnet --source admin-signer \
  --id $VAULT_CONTRACT_ID -- begin_migration --new_adapter $FIXED_ADAPTER_ID

# Wait MIN_LEDGER_GAP ledgers (~10 min on mainnet)

# Phase 2: Execute migration with slippage guard
stellar contract invoke --network mainnet --source admin-signer \
  --id $VAULT_CONTRACT_ID -- migrate_adapter \
  --new_adapter $FIXED_ADAPTER_ID --max_slippage_bps 500
```

If migration fails (slippage exceeded), funds never move — Soroban transactions are atomic. The snapshot survives and can be retried.

#### 3. Compromised Admin Key

**Immediate:**
1. Pause the vault: `set_paused(true)` — requires the compromised key, so this is only viable if you still control it
2. If the key is fully compromised and the attacker has not yet acted, use `transfer_admin()` to a new, uncompromised multisig before the attacker does

**If the attacker already controls admin:**
- There is no on-chain recovery mechanism. The vault's admin is immutable.
- The only mitigation is to notify depositors to withdraw and migrate to a new vault.
- This is why a 2-of-3 multisig is strongly recommended: a single compromised key cannot act alone.

#### 4. Lost Admin Key

- There is no recovery. `transfer_admin` requires the current admin's signature.
- If the key is lost, the vault becomes permanently frozen in its current configuration.
- Depositors can still withdraw (pause does not block withdrawals), but no admin actions are ever possible again.
- **Prevention:** Use a 2-of-3 multisig and maintain offline backups of all three keys.

### Incident Response Playbook

| Scenario | Detection | Response | Owner |
|----------|-----------|----------|-------|
| Unauthorized `migrate_adapter` | Event monitor alert (#707) | Immediate pause, investigate, rotate admin if key compromised | Security team |
| Vault TTL approaching expiry | Keeper health endpoint | Trigger manual TTL bump via `extend_position_ttl` keeper endpoint | DevOps |
| Slippage failure during migration | Failed transaction log | Retry with higher (but still capped) slippage; if repeated, investigate adapter | Engineering |
| Pause event without authorization | Event monitor alert | Verify if authorized; if not, assume compromise and begin incident response | Security team |

---

## Go-Live Checklist

Before calling any mainnet deployment "live", resolve or explicitly accept risk on every item below.

### Security

- [ ] [#557](https://github.com/drydocs/meridian/issues/557) Admin key is an unattended cron signer with no timelock and an unlimited slippage ceiling
  - **Mitigation:** Use 2-of-3 multisig for admin. Enforce 500 bps slippage cap off-chain in keeper config.
- [ ] [#551](https://github.com/drydocs/meridian/issues/551) Constructor argument pinning (already resolved; verify in deployed wasm)
- [ ] [#564](https://github.com/drydocs/meridian/issues/564) _<link and status>_ (placeholder; check actual issue)
- [ ] [#558](https://github.com/drydocs/meridian/issues/558) _<link and status>_ (placeholder; check actual issue)
- [ ] [#570](https://github.com/drydocs/meridian/issues/570) _<link and status>_ (placeholder; check actual issue)

### Infrastructure

- [ ] Event monitoring service deployed and alerting (#707)
- [ ] Keeper health endpoint configured for mainnet
- [ ] TTL bumping verified on all three contracts (vault, blend-adapter, defindex-adapter)
- [ ] Frontend contract addresses updated and tested against mainnet RPC
- [ ] Webhook alerts routed to on-call channel (Slack/Discord/PagerDuty)

### Documentation

- [ ] This runbook reviewed and signed off by at least two engineers
- [ ] Audit report received and all findings addressed or accepted
- [ ] Incident response contacts documented and accessible 24/7
- [ ] Key backups verified (all 3 multisig keys can successfully sign a test transaction)

### Final Verification

- [ ] `get_total_assets()` returns 0 on fresh deploy
- [ ] `get_adapter()` resolves to the correct adapter
- [ ] `is_paused()` returns false
- [ ] Deposit and withdraw smoke tests pass with real USDC (small amounts)
- [ ] Pause/unpause smoke test passes
- [ ] Event monitor catches and alerts on a test pause event

---

*Last updated: 2026-09-06*
