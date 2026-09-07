# Mainnet Deployment

[`testnet-deployment.md`](./testnet-deployment.md) covers the deploy scripts, the constructor-argument pattern that closes the front-running window (#505/#551), and the vault migration-history record. Read that first. This page only covers what is different, or additionally required, for mainnet. Nothing here duplicates it; where the mechanics are identical (constructor-argument wiring, `get_adapter()`/`get_pool()`/`get_protocol()` verification, the reproducible-builds caveat), it says so and points back rather than repeating it.

This does not include commissioning the security audit itself, which stays a firm-only, non-contributor engagement.

## Prerequisites specific to mainnet

- **A funded deployer with real XLM, not Friendbot.** `deploy-testnet.sh` assumes a Friendbot-funded throwaway key; mainnet has no Friendbot. Fund `DEPLOYER` from an exchange withdrawal or an existing mainnet account before starting. `DEPLOYER` still only pays fees and signs setup calls (it does not need to be kept afterward), but "throwaway" now means a key holding a small, deliberate amount of real XLM, not a free faucet grant.
- **Use `scripts/deploy-mainnet.sh` (#717), not `deploy-testnet.sh`.** `deploy-testnet.sh` hardcodes `NETWORK="testnet"` and silently defaults `ADMIN` to `DEPLOYER`'s own address with just a warning, both conveniences mainnet cannot tolerate. `deploy-mainnet.sh` hard-requires `ADMIN`/`ADMIN_KEY` (refusing to run if either is unset, or if they resolve to the same identity as `DEPLOYER`), validates `USDC_ID`/`BLEND_POOL_ID` against an allow-list checked into the script itself, and requires typing `MAINNET` to confirm before submitting anything. See "Deployment sequence" below for what it does step by step.
- **A durable, non-throwaway `ADMIN` key.** Per "The `DEPLOYER` / `ADMIN` split" in the testnet doc, `ADMIN` is already required to be a separate identity from `DEPLOYER`, but testnet only recommends this be durable; mainnet requires it. Concretely, `ADMIN` must be one of:
  - A **hardware-backed key** (Ledger), so the signing key itself never exists in plaintext on a machine that could be compromised. `stellar-cli` supports signing via Ledger through `stellar keys add --ledger`; consult the CLI's own `--help` for the version deployed, since Ledger support has evolved across `stellar-cli` releases.
  - A **native Stellar multisig account**: an account whose signers and thresholds are configured (via `set_options`) before the vault is deployed, so `ADMIN` names the multisig account itself and `admin.require_auth()` in the vault's constructor is satisfied by however many of that account's signers its threshold requires. This is not a Soroban-specific feature; it is the same multisig primitive classic Stellar accounts have always had. It does mean whoever assembles the deploying transaction needs the multisig's signatures collected before `ADMIN_KEY`'s transaction can be submitted, which takes real coordination time, so plan for that instead of discovering it mid-deploy.
  - At minimum, if neither of the above is ready yet, a single hardware-uninvolved key held in a password manager is the floor, not the target. See "Save the `ADMIN` secret key somewhere durable" in the testnet doc for why there is no recovery path if it's lost, which is a strictly worse outcome on mainnet with real funds behind it.
- **`ADMIN_KEY` must be sourced from whatever the above key actually is** (a Ledger-backed `stellar keys` alias, or the coordinating signer's process for a multisig) when running the vault's own deploy transaction (step 4 below). The constructor's `admin.require_auth()` needs a real signature from `ADMIN`, not `DEPLOYER`, exactly as on testnet, just with a key that is meaningfully harder to compromise.
- **`MERIDIAN_KEEPER_SECRET_KEY` / `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY` funded with real XLM.** These sign scheduled `accrue()`/`migrate_adapter()` transactions in production; see [Environment Variables](./environment-variables.md). `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY` in particular must be the vault's actual admin address, since `migrate_adapter` is admin-gated. Decide up front whether the migration keeper's key is a signer folded into the `ADMIN` multisig/Ledger setup above, or a narrower, separately-funded operational key the multisig `transfer_admin`s to for this purpose. Either is workable; picking neither and improvising later is not.
- **`UPSTASH_REDIS_REST_URL`/`_TOKEN` and `CRON_SECRET` configured before the first scheduled run**, not after. The migration keeper refuses to run on any deployed environment (including preview) without a shared Upstash store, see [Environment Variables](./environment-variables.md), and a missing `CRON_SECRET` fails closed in production, so there is no soft-launch window where keepers run unauthenticated or undeduplicated.
- **`MERIDIAN_ALERT_WEBHOOK_URL` configured** so the [admin-event alert keeper](./alert-keeper.md) is live from the first block onward, not added after the vault is already handling real deposits. This is what actually gives the longer `begin_migration` timelock (below) its value: a timelock nobody is watching is not a timelock.

## Parameter selection

Unlike `admin`/`usdc`/`musdc`/`adapter`, which are constructor arguments chosen at deploy time, the values below are compiled-in Rust constants: baked into the WASM you build and upload, not something you pass on the command line. There is nothing to "select" for these in the sense of a CLI flag; the parameter-selection work is confirming, before you build, that the values already in source are the ones you want live, since changing any of them means a full redeploy (adapters and the vault have no in-place upgrade path, see "Rollback plan" below).

| Parameter                                                                       | Value                            | Source                                                                  | Notes                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration timelock (`MIN_LEDGER_GAP`)                                           | 17,280 ledgers (~1 day)          | `packages/contracts/vault/src/storage.rs`                               | Raised from ~1 minute in #557 specifically so this is a real observation window on mainnet, not just a valuation-stability check. Do not lower this for a "faster" mainnet migration flow without understanding you are removing the thing #557 exists for.                                                                                   |
| Admin migration slippage ceiling (`MAX_ADMIN_SLIPPAGE_BPS`)                     | 500 bps (5%)                     | `packages/contracts/vault/src/storage.rs`                               | Hard ceiling on `migrate_adapter`'s caller-supplied `max_slippage_bps`, previously unbounded (up to 10,000/100%) other than the type range. A compromised or careless admin call can no longer authorize losing more than 5% in one migration.                                                                                                |
| Instance TTL bump / threshold (`INSTANCE_BUMP` / `INSTANCE_THRESHOLD`)          | 30 days / 29 days                | `packages/contracts/adapter-common/src/lib.rs`                          | Extended on every state-changing vault/adapter call (#553/#704) so a contract cannot archive itself between active use. Comfortably covers the 1-day migration timelock above; if that timelock is ever lengthened further, re-check it still fits well inside this window.                                                                   |
| Position TTL bump / threshold (`POSITION_BUMP` / `POSITION_THRESHOLD`)          | 120 days / 113 days              | `packages/contracts/vault/src/lib.rs`                                   | Per-depositor `Entry`/`Principal` records, deliberately bumped harder than instance TTL: a saver who deposits and does nothing for a quarter is the target user, not an edge case. The permissionless `extend_position_ttl()` entry point exists for a keeper or the depositor themselves to refresh this without needing a vault-level call. |
| DeFindex adapter slippage floor (`SLIPPAGE_BPS`)                                | 10 bps (0.1%)                    | `packages/contracts/defindex-adapter/src/lib.rs`                        | Floors `amounts_min`/`min_amounts_out` on DeFindex deposit/withdraw so those calls reject execution materially below what was requested (#558), rather than accepting any price DeFindex happens to offer.                                                                                                                                    |
| Migration keeper default/max slippage (`MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS`)   | default `100` bps, max `500` bps | Runtime env var, `packages/stellar-sdk-helpers/src/migration-keeper.ts` | This one _is_ a deploy-time choice, not a compiled constant, but its ceiling is enforced against the contract's own `MAX_ADMIN_SLIPPAGE_BPS` above, so it cannot be configured into a state the contract would reject anyway.                                                                                                                 |
| Migration keeper minimum improvement (`MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS`) | default `50` bps                 | Runtime env var                                                         | Minimum rate improvement a candidate protocol must clear before the keeper migrates to it, to avoid churning between two protocols within noise of each other.                                                                                                                                                                                |

Also confirm before building: `CONTRACT_ADDRESSES.mainnet` and `KNOWN_POOLS.mainnet` in `packages/shared/src/constants.ts` / `packages/stellar-sdk-helpers/src/known-pools.ts` now carry the real Meridian vault/mUSDC/Blend-pool addresses from the "Mainnet deployment record" below (DeFindex vault/factory are still placeholder-empty; no DeFindex mainnet deployment has happened). See "Updating the app to use the new deployment" below for what fills these in on a future redeploy, and don't assume they're already correct just because the testnet equivalents are.

## Deployment sequence

`scripts/deploy-mainnet.sh` (#717) runs the sequence below itself, prompting for the typed `MAINNET` confirmation after validating every input and before it uploads or deploys anything. Run it with `DEPLOYER`, `ADMIN`, `ADMIN_KEY`, `USDC_ID`, and `BLEND_POOL_ID` set (`bash scripts/deploy-mainnet.sh`), or add a reviewed Blend pool address to its `ALLOWED_BLEND_POOL_IDS` allow-list first if none is there yet. Mirrors "Standing up a fresh environment" in the testnet doc, minus the testnet-only conveniences:

1. Reserve the vault's contract address via `stellar contract id wasm` against mainnet's RPC/passphrase, sourced by `$ADMIN_ADDRESS`. Its salt is recorded and reused by step 4, so the vault lands at exactly this precomputed address.
2. Deploy the Blend adapter with that reserved vault address and USDC as constructor arguments, using the allow-listed **mainnet** Blend pool address, not a testnet one.
3. Deploy mUSDC with that same reserved vault address and its constructor arguments.
4. Deploy the vault itself, **sourced by `ADMIN_KEY`** (the hardware-backed or multisig key from the prerequisites above, not `DEPLOYER`), using the same salt from step 1, with `admin`, `usdc`, `musdc`, and `adapter` as constructor arguments. The script verifies the vault actually landed at the precomputed address before declaring success.
5. Run the exact same verification chain as "Verifying the deployment" in the testnet doc (`get_total_assets` returns `0`, `get_adapter` → `get_pool`/`get_protocol` resolve) before treating the deployment as live. A `HostError: Error(WasmVm, MissingValue)` here means the same thing it means on testnet: you're pointed at a stale build.
6. Confirm the deployed bytecode against a from-source CI rebuild, the same way and for the same reason as "A note on reproducible builds" in the testnet doc. This matters more on mainnet, not less, since a locally-built WASM that silently drifted from source is now backing real funds.

## Updating the app to use the new deployment

Same two files as testnet, mainnet keys instead of testnet keys:

```typescript
// packages/stellar-sdk-helpers/src/known-pools.ts
KNOWN_POOLS.mainnet["meridian-usdc"] = {
  id: "meridian-usdc",
  name: "Meridian",
  protocol: "meridian",
  label: "USDC Vault",
  contractId: "...", // VAULT_CONTRACT_ID
  assetId: "...", // mainnet USDC SAC address
  asset: "USDC",
};

// packages/shared/src/constants.ts
CONTRACT_ADDRESSES.mainnet.vault = "..."; // VAULT_CONTRACT_ID
CONTRACT_ADDRESSES.mainnet.musdc = "..."; // MUSDC_CONTRACT_ID
CONTRACT_ADDRESSES.mainnet.blend.pool = "..."; // the Blend pool actually deployed against
```

`KNOWN_POOLS.mainnet` currently has no `protocol: "meridian"` entry at all (only per-pool Blend entries used for APY ranking). This deployment is what adds the first one, not an edit to an existing entry the way the testnet cutover in "Vault migration history" was. `STELLAR_NETWORK=mainnet` also needs to be set wherever the API/keepers are deployed. See [Environment Variables](./environment-variables.md).

## Rollback plan

Adapter and vault contracts have no in-place upgrade path. This is already true on testnet (see "Pushing new adapter code to a live vault" and "Vault migration history" in the testnet doc) and does not change on mainnet, except that every scenario below now involves real depositor funds instead of testnet USDC. This section covers what to do when the deployed code itself needs to change. For live operational incidents where the code is fine but something is actively going wrong (a suspected admin key compromise, deciding whether to pause, rotating a keeper secret), see the incident-response runbook tracked as #721, not this page: #706's own scope is deploy-time rollback, and duplicating that content here would only let the two drift out of sync.

- **A bug is found in adapter code, vault not yet compromised.** Deploy a fixed adapter and cut over via `migrate_adapter` (vault has depositors) or `set_adapter` (it doesn't), exactly the testnet procedure, admin-authorized either way. No user action required; positions are denominated in vault shares and untouched by the swap.
- **A bug is found in vault code itself.** There is no adapter-swap equivalent for the vault. This requires a full cutover: deploy a new vault (plus new mUSDC) per "Deployment sequence" above, update `CONTRACT_ADDRESSES`/`KNOWN_POOLS` to point the app at it, and leave the old vault running untouched but unreachable through the app. `withdraw()` still works on the old contract for anyone holding shares there; there is no automatic migration or sweep. Communicate the cutover to depositors and expect a manual withdraw-then-redeposit on their part, the same as the 2026-08-20 testnet cutover documented in "Vault migration history".

`begin_migration`'s ~1-day timelock (see parameter selection above) is the intended detection-and-reaction window for a malicious `begin_migration` call, and the [alert keeper](./alert-keeper.md) is what surfaces that immediately rather than by chance; what to actually do about it once surfaced is #721's territory. `get_migration_snapshot()` and the admin-history endpoints (`getRpcAdminHistory`) are readable by anyone, not just the admin, and are useful for independently verifying on-chain state during any of the above rather than trusting the frontend's cached view of it.

## Go-live checklist

The security-relevant issues this runbook's proposal cross-references are all resolved as of this writing:

- [x] #557: admin migration slippage cap and timelock (this page's parameter-selection table)
- [x] #551: `MeridianVault::initialize()` front-running (constructor-argument pattern, see testnet doc)
- [x] #564: mUSDC supply exclusivity (custom SEP-41 token, #578)
- [x] #558: zero slippage floor on DeFindex adapter deposit/withdraw
- [x] #570: overflow error on divide-by-zero

None of these block a mainnet deploy today. What remains before going live:

- [ ] Security audit commissioned and findings resolved (firm-only engagement, explicitly out of scope for this runbook, see the note at the top)
- [ ] `ADMIN` key custody finalized (hardware-backed or multisig, per "Prerequisites specific to mainnet") and its holder(s) briefed on the incident-response runbook (#721) once it exists
- [x] `scripts/deploy-mainnet.sh`'s `ALLOWED_BLEND_POOL_IDS` allow-list populated with a reviewed mainnet Blend pool address (independently verified against a real on-chain deposit transaction, not just the label). Not separately rehearsed against testnet's own RPC first; the deploy below was its first real run.
- [ ] #721 (incident-response runbook) landed and its holder(s) briefed, so a live incident has a documented playbook to follow rather than being improvised
- [ ] `MERIDIAN_KEEPER_SECRET_KEY` / `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY` funded and their custody model decided (folded into `ADMIN`'s multisig, or a separate operational key)
- [ ] `UPSTASH_REDIS_REST_URL`/`_TOKEN`, `CRON_SECRET`, and `MERIDIAN_ALERT_WEBHOOK_URL` configured on the production deployment before the first scheduled keeper run, not after
- [ ] `.github/workflows/keepers.yml`'s cron schedule enabled against the production `API_BASE_URL`
- [x] `CONTRACT_ADDRESSES.mainnet` / `KNOWN_POOLS.mainnet` populated with the real deployed addresses per "Updating the app to use the new deployment"
- [x] Post-deploy verification chain (step 5 of "Deployment sequence") run and its output recorded, see "Mainnet deployment record" below

## Mainnet deployment record

Deployed 2026-09-07, using `mainnet-deployer` (`GAAMI2TTCG4526SWGFDA4LOBEOPLYFUMMGMSLRMWNMC4PGCC5F2SOVZU`) as `DEPLOYER` and `mainnet-admin` (`GBO6FBVTHGNDT33T4MCW3FAVIRP3H2LAHURRK6B4B23274V6RMFHOWMW`) as `ADMIN`/`ADMIN_KEY`, wired to Circle's mainnet USDC and the Blend mainnet USDC pool (Fixed V2). No audit was commissioned before this deploy; see the security-audit checklist item above, still open.

- vault: `CCJZCEF47TMOA6ECPQD5LZZ2H75YX53FUEZJQZSJLGK4TWGXQZG2KODU`
- blend-adapter: `CADWOVTT5KUFFSTIQ3T5XPAQISEDQYPMSJ4CEU2CRGOBKA5QP4BRROBJ`
- mUSDC: `CDNQXOWKOCWB4YVK33HACZ2O2OL7C7ZZ37AJRWZDZQ2QK52NYW7ATDFS`
- USDC: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
- Blend pool: `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD`

Verification chain, run against the live contracts after deployment (not just the deploy script's own reported success):

- `vault.get_admin()` → `mainnet-admin`'s address, matches `ADMIN`
- `vault.get_adapter()` → the blend-adapter address above
- `vault.is_paused()` → `false`
- `blend-adapter.get_pool()` → the Blend pool address above
- `blend-adapter.get_protocol()` → `"blend"`
- `mUSDC.admin()` → the vault address above
- `mUSDC.name()` / `symbol()` / `decimals()` → `"Meridian USDC"` / `"mUSDC"` / `7`

The reproducible-build check against a from-source CI rebuild (step 6 of "Deployment sequence") has not been run yet for this deployment; do that before treating the on-chain bytecode as fully verified, not just the constructor wiring above.

Two deploy attempts against this vault's precomputed address failed partway through before this one succeeded, each due to transient RPC issues rather than any logic or funding problem confirmed to have actually landed on-chain (checked directly against Horizon/RPC before retrying each time, never assumed): an initial run hit `TxInsufficientBalance` on the vault WASM upload (mainnet Soroban code-storage rent for these contract sizes runs to tens of XLM, not the few XLM assumed going in) and a `transaction submission timeout` on the mUSDC deploy; a second run then hit a `transaction submission timeout` on the blend-adapter deploy, twice, across two different public RPC endpoints. Both left a permanently orphaned blend-adapter deployed against a vault address whose salt was not yet persisted anywhere (`CDOFBH7DHACLERGQB56GDXHOZOMUCEHCMPOWIVTAFZBJXJC7GRETP6GD`, wired to the never-deployed `CAH5LOUGQPHAIUMQPUOVFAFNEEZTHJI7IVIAJ7DEC6RA45DJG577ZK4L` — harmless, holds no funds, not referenced anywhere). `deploy-vault-stack.sh` now accepts an optional `VAULT_SALT` env var, printed on every run, so a future partial failure can resume at the same reserved address instead of repeating this.
