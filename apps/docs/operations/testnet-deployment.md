# Testnet Deployment

Meridian ships two deploy scripts, both in `scripts/`. Which one you need depends on what you're doing:

| Script                              | Use when                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/deploy-testnet.sh`         | Standing up a brand new environment: vault, a `BlendAdapter`, and the mUSDC share token (a custom SEP-41 contract, #578), all initialized and wired together. |
| `scripts/redeploy-blend-adapter.sh` | Pushing new adapter code (e.g. a fix to `accrue()`, `get_pool()`, `get_protocol()`) onto an **already-live** vault, without redeploying the vault itself.     |

Neither script requires manual `stellar contract invoke` steps — read them before running if you want to understand exactly what they do; they're short and heavily commented.

## Prerequisites

- Stellar CLI: `cargo install stellar-cli` (the CLI binary is `stellar`, not `soroban` — the older `soroban-cli` is deprecated)
- Rust with the `wasm32v1-none` target: `rustup target add wasm32v1-none`. Note `stellar contract build` targets `wasm32v1-none`, not `wasm32-unknown-unknown` — if you've followed older Soroban tutorials, this is the one place that trips people up.

## The `DEPLOYER` / `ADMIN` split

Both scripts require a `DEPLOYER` secret key, funded via [Friendbot](https://friendbot.stellar.org/). `DEPLOYER` only pays transaction fees and signs the setup calls — it does **not** need to be kept around afterward, and can be thrown away once the script finishes.

`deploy-testnet.sh` additionally accepts an optional `ADMIN` **public key**. This becomes the deployed vault's permanent admin, the only address that can ever call `transfer_admin`, `set_paused`, `set_adapter`, or `migrate_adapter` on it. `ADMIN` is deliberately independent of `DEPLOYER` as an identity — but not as a _signer_: the vault takes `admin`/`usdc`/`musdc`/`adapter` as **constructor arguments** (#551, same fix #505/#550 already applied to the adapters/mUSDC), so its state is set inside its own deploying transaction with no separate `initialize()` step to front-run. Unlike the adapters/mUSDC's constructor arguments, `admin` is a human-held key, not a programmatically-derived contract address, so the constructor calls `admin.require_auth()` too, and Soroban only honors that inside a constructor for the transaction's own source account. So when `ADMIN` differs from `DEPLOYER`, pass the `ADMIN` signing key as `ADMIN_KEY` (a secret key, or a `stellar keys` alias) alongside it, and the script sources the vault's deploy transaction with `ADMIN_KEY` itself rather than `DEPLOYER`. `ADMIN_KEY` is validated up front: if it resolves to an address other than `ADMIN`, the script exits before building anything. If you don't set `ADMIN`, the script defaults it (and `ADMIN_KEY`) to `DEPLOYER`'s own address/key — fine for a quick throwaway test, but you should always set `ADMIN` explicitly to a separate, durable key for anything you intend to keep testing against, and it **must** be set explicitly ahead of any mainnet deployment.

**Set `ADMIN_KEY` whenever the key is on the machine running the script.** Without it, the script cannot source the vault's deploy transaction itself, so it deploys `BlendAdapter` and mUSDC (both already wired to the vault's precomputed address) and then prints the vault's own deploy command, using that same precomputed address's salt, for the `ADMIN` key holder to run. Unlike the old two-step deploy-then-`initialize()` flow this replaced, there is no "deployed but claimable" window in that case: the vault simply does not exist on-chain at all until that command is run, by `ADMIN` specifically.

Save the `ADMIN` secret key somewhere durable (a password manager, not a plaintext file) the moment you deploy with it — there is no recovery path if it's lost. `transfer_admin`/`set_paused`/`set_adapter` become permanently inaccessible, and since adapters have no in-place upgrade path, that also means the vault can never be pointed at fixed adapter code again.

## Standing up a fresh environment

```bash
# Generate and fund a throwaway deployer key
stellar keys generate my-deployer --fund --network testnet
DEPLOYER_ADDR=$(stellar keys address my-deployer)

# Generate and fund a separate, durable admin key (keep this one). It must be
# funded too: it sources the vault's own deploy transaction, see below.
stellar keys generate my-admin --fund --network testnet
ADMIN_ADDR=$(stellar keys address my-admin)

# ADMIN_KEY lets the script source the vault's deploy transaction itself, so
# the vault is never left undeployed and waiting on a second manual step.
DEPLOYER=my-deployer ADMIN=$ADMIN_ADDR ADMIN_KEY=my-admin bash scripts/deploy-testnet.sh
```

This builds all four contract crates (`vault`, `blend-adapter`, `defindex-adapter`, `musdc-token`), uploads and deploys the vault, a `BlendAdapter`, and mUSDC — a custom SEP-41 token (#578), not a Stellar Asset Contract — and wires everything together:

1. Reserves the vault's contract address up front via `stellar contract id wasm --source-account $ADMIN_ADDR --salt`, without deploying anything yet. Soroban contract IDs are deterministic from (network, source account, salt) alone, independent of the wasm deployed, so this address is known before the vault itself exists. The source account used here must match whichever account actually sources the vault's own deploy in step 4, since the computed address depends on it.
2. Deploys the `BlendAdapter` with that reserved vault address, Blend's testnet pool, and USDC passed as **constructor arguments**, so the adapter is wired inside the transaction that creates it. There is no separate adapter `initialize()` step: that gap was front-runnable (#505). See "Adapter deployment and initialization" in [`architecture/vault-contract.md`](../architecture/vault-contract.md).
3. Deploys mUSDC with that same reserved vault address, decimals, name, and symbol passed as **constructor arguments** too, for the same reason: mUSDC's `admin` is set inside the transaction that creates it, so it's never observable on-ledger with the wrong admin.
4. Deploys the vault itself, sourced by `ADMIN_KEY` and using the same salt from step 1 so it lands at the address already reserved and handed to the two contracts above, with `admin`, `usdc`, `musdc`, and `adapter` passed as constructor arguments. Its own state is set inside this deploying transaction the same way, so there is no deploy-then-initialize gap here either (#551), and `admin.require_auth()` inside the constructor proves `ADMIN`'s key genuinely exists and its holder consents.

It prints the three contract IDs you need at the end:

```text
VAULT_CONTRACT_ID=...
BLEND_ADAPTER_CONTRACT_ID=...
MUSDC_CONTRACT_ID=...
```

USDC and the Blend pool address default to the existing testnet contracts (`USDC_ID`, `BLEND_POOL_ID` env vars override them if you need to point somewhere else).

## Updating the app to use the new deployment

The frontend and API discover the vault and mUSDC contract addresses from two places — both need updating:

```typescript
// packages/stellar-sdk-helpers/src/known-pools.ts
KNOWN_POOLS.testnet["meridian-usdc"].contractId = "..."; // VAULT_CONTRACT_ID

// packages/shared/src/constants.ts
CONTRACT_ADDRESSES.testnet.vault = "..."; // VAULT_CONTRACT_ID
CONTRACT_ADDRESSES.testnet.musdc = "..."; // MUSDC_CONTRACT_ID
```

The adapter contract address is **not** hardcoded anywhere in the app — the frontend discovers the active adapter live via `vault.get_adapter()`, and that adapter's `get_pool()`/`get_protocol()`, rather than tracking it in config. This is deliberate: it means the app self-updates if the adapter is ever swapped via `set_adapter` or `migrate_adapter`, with nothing that could drift out of sync.

## Verifying the deployment

```bash
stellar contract invoke --network testnet --source my-deployer \
  --id $VAULT_CONTRACT_ID -- get_total_assets
```

`0` confirms the contract is initialized and responding (a fresh vault has no deposits yet). You can also confirm the full adapter chain resolves correctly:

```bash
stellar contract invoke --network testnet --source my-deployer \
  --id $VAULT_CONTRACT_ID -- get_adapter
# -> BLEND_ADAPTER_CONTRACT_ID

stellar contract invoke --network testnet --source my-deployer \
  --id $BLEND_ADAPTER_CONTRACT_ID -- get_pool
# -> the Blend pool address

stellar contract invoke --network testnet --source my-deployer \
  --id $BLEND_ADAPTER_CONTRACT_ID -- get_protocol
# -> "blend"
```

This is exactly the call chain the frontend uses to discover live APY (`vault.get_adapter()` → `adapter.get_pool()`/`get_protocol()`). If any of these calls fail with `HostError: Error(WasmVm, MissingValue)`, the deployed contract predates the functions you're calling — you're pointed at a stale vault, not this one.

## Pushing new adapter code to a live vault

Adapter contracts have no in-place upgrade path. To get new adapter code (a bug fix, a new feature) onto an already-live vault, deploy a fresh adapter and swap the vault onto it:

```bash
# VAULT_ID is required: the vault address is a constructor argument, baked into
# the adapter permanently by the deploying transaction.
VAULT_ID=$VAULT_CONTRACT_ID DEPLOYER=my-deployer bash scripts/redeploy-blend-adapter.sh
```

This builds and deploys a new `BlendAdapter`, wired to the same vault/pool/USDC through its constructor arguments, and then **prints, but does not run**, the final swap command. Which command it prints depends on whether the vault already has depositors, so check that first:

```bash
stellar contract invoke --network testnet --source my-deployer \
  --id $VAULT_CONTRACT_ID -- get_total_shares
```

### Vault with depositors (`get_total_shares > 0`) — `migrate_adapter`

```bash
stellar contract invoke --network testnet --source $DEPLOYER \
  --id $VAULT_ID -- migrate_adapter --new-adapter $NEW_ADAPTER_ID --max-slippage-bps 100
```

`migrate_adapter` moves the vault's entire position from the old adapter to the new one atomically, comparing the value that lands on the new adapter against the old adapter's value before extraction and reverting if the difference exceeds `--max-slippage-bps` (basis points, max `500` as of #557; previously `10000`). Per-depositor bookkeeping is denominated in vault shares, not adapter shares, so it is left untouched — **no depositor has to withdraw first**. It fails with `SameAdapter` if the new adapter is the one already installed, and with `NoAdapterPosition` if the vault holds no adapter position at all (which is the zero-depositor case below).

### Fresh vault, no depositors yet (`get_total_shares == 0`) — `set_adapter`

```bash
stellar contract invoke --network testnet --source $DEPLOYER \
  --id $VAULT_ID -- set_adapter --new-adapter $NEW_ADAPTER_ID
```

`set_adapter` is simpler but it only resets the vault's adapter-share accounting (`ADPT_SH`) to zero and moves no funds. On a vault that _does_ hold a position, anything deposited through the current adapter becomes unreachable through the vault's normal withdraw flow the moment you swap — which is why `migrate_adapter` exists and is the correct choice there.

Both commands are deliberately left for you to run by hand, and both require `admin.require_auth()` — the `--source` key must be the vault's actual admin. The script prints them with `--source $DEPLOYER`, so if your deployer key is not the vault admin, substitute the admin key before running.

## Getting testnet USDC

Blend's testnet pool uses USDC issued by Blend's own controlled test key, not Circle's testnet USDC — the two are different Stellar assets that happen to share an asset code. Fund a testnet wallet from [Blend's public faucet](https://testnet.blend.capital) or via its API endpoint (`fundFromBlendFaucet()` in `apps/web/src/hooks/useBlendFaucet.ts` calls this automatically when a depositing wallet has no USDC balance). In practice the default faucet call reliably grants BLND/wETH/wBTC but has not reliably granted USDC in testing — if a deposit fails with a missing-trustline or insufficient-balance error, you may need to fund the wallet directly through Blend's own faucet UI.

## Vault migration history

Adapter and vault contracts have no in-place upgrade path (see "Pushing new adapter code to a live vault" above for adapters; the vault itself is the same story). Shipping a vault-level change — new functionality, a bugfix — means a full cutover: deploy a new vault (+ new mUSDC), point `CONTRACT_ADDRESSES`/`KNOWN_POOLS` at it, and leave the old vault contract running, untouched, but unreachable through the app/docs from then on. This section is the durable record of each cutover: what the old address was, why it was superseded, and whether it still holds anything.

### 2026-08-20 — redeployed for `migrate_adapter` (#514)

The live testnet vault predated `migrate_adapter` (added in #464/#507, never on the live contract since — see #514 for the full writeup, including how `.github/workflows/verify-contract-addresses.yml`'s bytecode check caught it).

**Pre-cutover status, at the time this PR was opened:** the old vault below held `get_total_assets() = 200000000000` (20,000 USDC) in outstanding testnet deposits. If you hold a position there, **withdraw before this PR merges** — once merged, the app and `KNOWN_POOLS`/`CONTRACT_ADDRESSES` point at the new vault, and the old one is no longer reachable through the UI (though it keeps working, see below).

**Old vault (superseded):**

| Field               | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Vault contract      | `CBQYEHWIRJWIPWCJFQZAOP3VAZHRWFGAUS5GZHWFDDYKMFHJ5S3YS2Q5` |
| mUSDC (share token) | `CBC5G4HXTOOZHTBCJQACZB3NJ636JHA5NEBQX5Q265QZN6XEG4LVZ5SB` |
| mUSDC issuer        | `GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD` |
| Admin               | `GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD` |

This contract is not deleted or disabled — Soroban has no such operation, it keeps running exactly as deployed. `withdraw()` still works on it for anyone who already holds shares there:

```bash
stellar contract invoke --network testnet --source <your-key> \
  --id CBQYEHWIRJWIPWCJFQZAOP3VAZHRWFGAUS5GZHWFDDYKMFHJ5S3YS2Q5 \
  -- withdraw --caller <your-address> --shares <amount>
```

There is no automatic migration or sweep of old positions into the new vault — moving a position across a cutover is a manual withdraw-then-redeposit, not something the vault or its keepers do for you.

**New vault (current):**

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vault contract      | `CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL`                                                                                                                                                                                                                                                                                                                     |
| Blend adapter       | `CDFIDKNA2ZTB37I7RN32WH7VU5AP2PAOXLGFWMTW6T2RSUM23AJIV2YM`                                                                                                                                                                                                                                                                                                                     |
| mUSDC (share token) | `CCSYXC4SDCPTGENHM6CSQY4HMSZOPOY5TJW4QYYLE5RDBUBJX4N7ZHV5`                                                                                                                                                                                                                                                                                                                     |
| mUSDC issuer        | `GBLYQ5EHXMMULOA7KA4KK2S5Q5GTTWYFVSC3FKLXRLH34EJX35BIAL35`                                                                                                                                                                                                                                                                                                                     |
| Admin               | `GB74ZDVMBYMPKWBBVJ7TAN2QK2EAKQQ5OZO6ETYAMPN5VQVNLZSQUYHH` — a fresh, separate key generated for this deployment (not the deploying key), per "The `DEPLOYER` / `ADMIN` split" above. Its secret is currently held by this PR's author; rotate it via `transfer_admin`/`accept_admin` (no redeploy required) if maintainers want a different durable key in control long-term. |

Verified against #514's acceptance criteria before opening this PR: `migrate_adapter` is present in the deployed vault's function list (`stellar contract invoke ... -- --help`), `vault.get_adapter()` resolves to the Blend adapter above, and that adapter's `get_pool()`/`get_protocol()` resolve correctly — the same chain "Verifying the deployment" above walks through. Also confirmed the deployed vault's on-chain bytecode hash byte-for-byte against a from-source rebuild done on GitHub Actions itself (not a local machine — see the note below on why that distinction matters), matching what `.github/workflows/verify-contract-addresses.yml`'s "Verify On-Chain Bytecode" job independently rebuilds and checks.

**A note on reproducible builds:** `stellar contract build`'s WASM output is not guaranteed byte-identical across different `stellar-cli`/Rust toolchain versions, even from identical source — a newer `stellar-cli` can apply a different (or newly-default) optimization pass and pull in different `soroban-sdk` transitive versions, changing the compiled bytecode. `.github/workflows/verify-contract-addresses.yml` always rebuilds with whatever `stellar-cli` version `cargo install --locked stellar-cli` resolves to _at CI run time_, not a pinned version. If your local `stellar-cli` has drifted behind that (check with `stellar --version` against the [latest release](https://github.com/stellar/stellar-cli/releases)), a contract you deploy locally can genuinely mismatch what CI rebuilds and compares it against, independent of whether your source is correct. If in doubt, verify the WASM you're about to deploy was built with a `stellar-cli` at least as new as CI's, or build it in a CI job of your own (e.g. a throwaway `workflow_dispatch` job that uploads the built `.wasm` as an artifact) and deploy that exact artifact instead of a locally-built one.

### 2026-09-01 — redeployed for `deposit()`'s `min_shares_out` and two-phase migration (#604, #606)

The live testnet vault predated both #604 (`deposit()` gained a required `min_shares_out` parameter) and #606 (`begin_migration`/two-phase migration cooldown), landing exactly the ABI mismatch #602 was filed to prevent — #602 covered #600's `withdraw()` change and closed before #604/#606 merged, so neither was ever redeployed. Callers built against current source (three-argument `deposit()`) were failing simulation against the old two-argument contract with `HostError: Error(WasmVm, UnexpectedSize)`.

**Pre-cutover status:** the old vault below held `get_total_assets() = 0` — no outstanding testnet deposits, so no withdrawal-announcement window was needed.

**Old vault (superseded):**

| Field               | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Vault contract      | `CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL` |
| Blend adapter       | `CDFIDKNA2ZTB37I7RN32WH7VU5AP2PAOXLGFWMTW6T2RSUM23AJIV2YM` |
| mUSDC (share token) | `CCSYXC4SDCPTGENHM6CSQY4HMSZOPOY5TJW4QYYLE5RDBUBJX4N7ZHV5` |
| Admin               | `GB74ZDVMBYMPKWBBVJ7TAN2QK2EAKQQ5OZO6ETYAMPN5VQVNLZSQUYHH` |

This contract is not deleted or disabled — Soroban has no such operation, it keeps running exactly as deployed. There is no automatic migration or sweep of old positions into the new vault, but there were none to move at cutover time.

**New vault (current):**

| Field               | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Vault contract      | `CC3WA7SSJOI7WJPLWEGHSK3GRD3PSQXAIOQTXQEHBXYIIVJFZR4ZVAYP` |
| Blend adapter       | `CDHUA2PW62YTU4MS2KDBPQ3UKXSZORVTHM43PMIT2VDIMVGXTKQHANY5` |
| mUSDC (share token) | `CDMPSG5HRSSPADIR5JKZM5CWTZFN3AAJEJV5K5QXOXVOZHAWJ7EKZB7H` |
| Admin               | `GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD` |

Deployed and initialized via `scripts/deploy-testnet.sh`, `DEPLOYER` and `ADMIN` both defaulting to the same key (a pre-existing, already-funded testnet identity previously used as the #514 cutover's admin too). `begin_migration`, `migrate_adapter`, and the three-argument `deposit()` all confirmed present in the deployed vault's exported function list.

### 2026-09-02 — redeployed to fix a `stellar-cli` version drift (#701)

`.github/workflows/verify-contract-addresses.yml`'s "Verify On-Chain Bytecode" job started failing: rebuilding the vault from current source on CI produced a WASM hash (`d46c31020b6eb369ba84a87cbdbd9b0972c3ac8fa732b08a4915f6b262d5f179`) that didn't match the on-chain hash of the live vault below. Source hadn't drifted — the vault had simply been deployed with an older `stellar-cli` than what CI's dynamic `cargo install --locked stellar-cli` now resolves to (v28.0.0), and `stellar contract build`'s output isn't guaranteed byte-identical across CLI versions (see "A note on reproducible builds" above). Confirmed independently: rebuilding locally after upgrading to `stellar-cli` v28.0.0 produced the identical `d46c31020b...` hash CI did, on a separate machine.

**Pre-cutover status:** the old vault below held `get_total_assets() = 0` — no outstanding testnet deposits, so no withdrawal-announcement window was needed.

**Old vault (superseded):**

| Field               | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Vault contract      | `CC3WA7SSJOI7WJPLWEGHSK3GRD3PSQXAIOQTXQEHBXYIIVJFZR4ZVAYP` |
| Blend adapter       | `CDHUA2PW62YTU4MS2KDBPQ3UKXSZORVTHM43PMIT2VDIMVGXTKQHANY5` |
| mUSDC (share token) | `CDMPSG5HRSSPADIR5JKZM5CWTZFN3AAJEJV5K5QXOXVOZHAWJ7EKZB7H` |
| Admin               | `GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD` |

This contract is not deleted or disabled — Soroban has no such operation, it keeps running exactly as deployed. There is no automatic migration or sweep of old positions into the new vault, but there were none to move at cutover time.

**New vault (current):**

| Field               | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Vault contract      | `CBOQTI3C7UHTBRHSF3AJEQYXDINJ354XRWIZKSEV6PFIEUSJF2YWZPME` |
| Blend adapter       | `CCXB5BRVBFNPAN72PRODGFWKGGDHEHJMHJLC7G2OEQFF4PZNNO3C4XBH` |
| mUSDC (share token) | `CAJASVPQ365EYUQ62Z54SRSZWJ4C7WJNDYXIYVWKLSRWJTTWET35JPYE` |
| Admin               | `GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD` |

The admin is the same durable key as the two prior cutovers, kept across this one too. Deployed via `scripts/deploy-testnet.sh` with a fresh throwaway `DEPLOYER` and `ADMIN`/`ADMIN_KEY` set explicitly to that durable admin key, so the vault was signed and initialized in the same run rather than left briefly claimable. `get_total_assets()`, `get_pool()`, and `get_protocol()` confirmed resolving correctly on the new vault and its Blend adapter.

### 2026-09-06: redeployed for the TTL, event, and migration-timelock changes (#701)

The previous vault predated four contract-touching PRs merged since the last cutover: #704 (instance/position TTL management), #711 (event emission on deposit/withdraw), #705 (an off-chain migration-keeper fix, no contract change but confirms the pairing), and #710 (`MAX_ADMIN_SLIPPAGE_BPS` slippage cap and the `MIN_LEDGER_GAP` timelock extension from ~1 minute to ~1 day). None of these changed argument counts the way #604/#606 did, so the vault kept simulating deposits successfully, but shipping the security-relevant #557 fix (the longer timelock) live only once #701 completed the build-pipeline fix made this the natural point to redeploy rather than leave the fix undeployed indefinitely.

**Pre-cutover status:** the old vault below held `get_total_assets() = 0`, no outstanding testnet deposits, so no withdrawal-announcement window was needed.

**Old vault (superseded):**

| Field               | Value                                                       |
| ------------------- | ------------------------------------------------------------ |
| Vault contract      | `CBOQTI3C7UHTBRHSF3AJEQYXDINJ354XRWIZKSEV6PFIEUSJF2YWZPME` |
| Blend adapter       | `CCXB5BRVBFNPAN72PRODGFWKGGDHEHJMHJLC7G2OEQFF4PZNNO3C4XBH` |
| mUSDC (share token) | `CAJASVPQ365EYUQ62Z54SRSZWJ4C7WJNDYXIYVWKLSRWJTTWET35JPYE` |
| Admin               | `GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD` |

This contract is not deleted or disabled: Soroban has no such operation, it keeps running exactly as deployed. There is no automatic migration or sweep of old positions into the new vault, but there were none to move at cutover time.

**New vault (current):**

| Field               | Value                                                       |
| ------------------- | ------------------------------------------------------------ |
| Vault contract      | `CBNXROTWUVHNRRI2LRKHEXJXIWPJTOZOMMMMX7KNQEJAY5ZOGSM7LYZ7` |
| Blend adapter       | `CB2GNYVHJ6O2QX2ZEP5EIHRBC26W6VE3APVPU3PD6JVQR5KQIVBOLALC` |
| mUSDC (share token) | `CDJ6A3ISCVLZRHVUQC6SWVZDFMMXSK5I6XUUUO3FKJWCQSMXKOZK3YIO` |
| Admin               | `GDZX7DOZMVEZJSWPDIZCTSCAKW4LBB3UGNWYAG5YTCBL4JPMUPAWWEUD` |

The admin is the same durable key as all three prior cutovers, kept across this one too. Deployed via `scripts/deploy-testnet.sh` with `DEPLOYER=cutover-deployer` (a pre-funded throwaway testnet identity) and `ADMIN`/`ADMIN_KEY` set explicitly to that durable admin key, built with `stellar-cli` v28.0.0, matching what `.github/workflows/verify-contract-addresses.yml` resolves at the time of this cutover. `extend_position_ttl`, `begin_migration`, `migrate_adapter`, and `on_transfer` all confirmed present in the deployed vault's exported function list, and `begin_migration`'s own doc text in that output already reflects the ~1-day timelock. `get_total_assets()`, `get_adapter()`, and the resulting Blend adapter's `get_pool()`/`get_protocol()` confirmed resolving correctly.

## Run the signing flow end-to-end

With the contracts deployed and `known-pools.ts`/`constants.ts` updated:

1. Open the app, connect Freighter (testnet mode).
2. Enter a USDC amount and click **Deposit**.
3. Freighter displays the transaction details; verify the contract address matches `VAULT_CONTRACT_ID`.
4. Approve the transaction.
5. After ~5 seconds, the position summary updates with your deposited amount.
