# Testnet Deployment

Meridian ships two deploy scripts, both in `scripts/`. Which one you need depends on what you're doing:

| Script                              | Use when                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/deploy-testnet.sh`         | Standing up a brand new environment: vault, router, a `BlendAdapter`, and an mUSDC share token, all initialized and wired together.                       |
| `scripts/redeploy-blend-adapter.sh` | Pushing new adapter code (e.g. a fix to `accrue()`, `get_pool()`, `get_protocol()`) onto an **already-live** vault, without redeploying the vault itself. |

Neither script requires manual `stellar contract invoke` steps — read them before running if you want to understand exactly what they do; they're short and heavily commented.

## Prerequisites

- Stellar CLI: `cargo install stellar-cli` (the CLI binary is `stellar`, not `soroban` — the older `soroban-cli` is deprecated)
- Rust with the `wasm32v1-none` target: `rustup target add wasm32v1-none`. Note `stellar contract build` targets `wasm32v1-none`, not `wasm32-unknown-unknown` — if you've followed older Soroban tutorials, this is the one place that trips people up.

## The `DEPLOYER` / `ADMIN` split

Both scripts require a `DEPLOYER` secret key, funded via [Friendbot](https://friendbot.stellar.org/). `DEPLOYER` only pays transaction fees and signs the setup calls — it does **not** need to be kept around afterward, and can be thrown away once the script finishes.

`deploy-testnet.sh` additionally accepts an optional `ADMIN` **public key**. This becomes both the deployed vault's permanent admin (the only address that can ever call `set_admin`, `set_paused`, `set_adapter`, or `migrate_adapter` on it) and the router's admin (the only address that can call `add_vault`/`remove_vault` to manage which vaults `rebalance()` will accept). `ADMIN` is deliberately independent of `DEPLOYER`: whoever calls `initialize()` can pass in any address as the admin, since it's just a parameter, not tied to who signed the deploy transaction. If you don't set `ADMIN`, the script defaults it to `DEPLOYER`'s own address and prints a warning — fine for a quick throwaway test, but you should always set `ADMIN` explicitly to a separate, durable key for anything you intend to keep testing against, and it **must** be set explicitly ahead of any mainnet deployment.

Save the `ADMIN` secret key somewhere durable (a password manager, not a plaintext file) the moment you deploy with it — there is no recovery path if it's lost. `set_admin`/`set_paused`/`set_adapter` become permanently inaccessible, and since adapters have no in-place upgrade path, that also means the vault can never be pointed at fixed adapter code again.

## Standing up a fresh environment

```bash
# Generate and fund a throwaway deployer key
stellar keys generate my-deployer --fund --network testnet
DEPLOYER_ADDR=$(stellar keys address my-deployer)

# Generate and fund a separate, durable admin key (keep this one)
stellar keys generate my-admin --fund --network testnet
ADMIN_ADDR=$(stellar keys address my-admin)

DEPLOYER=my-deployer ADMIN=$ADMIN_ADDR bash scripts/deploy-testnet.sh
```

This builds all four contract crates (`vault`, `router`, `blend-adapter`, `defindex-adapter`), uploads and deploys the vault, router, and a `BlendAdapter`, deploys a fresh mUSDC Stellar Asset Contract, and wires everything together:

1. Initializes the `BlendAdapter` with the vault address, Blend's testnet pool, and USDC.
2. Initializes the vault with `admin`, `usdc`, `musdc`, and `adapter` (the just-deployed `BlendAdapter`).
3. Sets the vault as mUSDC's admin, so it can mint/burn shares autonomously.
4. Initializes the router with `admin`, then adds the just-deployed vault to the router's allowlist so `rebalance()` will accept it.

It prints the four contract IDs you need at the end:

```text
VAULT_CONTRACT_ID=...
ROUTER_CONTRACT_ID=...
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

The router and adapter contract addresses are **not** hardcoded anywhere in the app — the frontend discovers the active adapter live via `vault.get_adapter()`, and that adapter's `get_pool()`/`get_protocol()`, rather than tracking it in config. This is deliberate: it means the app self-updates if the adapter is ever swapped via `set_adapter`, with nothing that could drift out of sync.

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
VAULT_ID=$VAULT_CONTRACT_ID DEPLOYER=my-deployer bash scripts/redeploy-blend-adapter.sh
```

This builds and deploys a new `BlendAdapter`, initializes it against the same vault/pool/USDC, and then **prints, but does not run**, the final `set_adapter` command:

```bash
stellar contract invoke --network testnet --source $ADMIN \
  --id $VAULT_ID -- set_adapter --new-adapter $NEW_ADAPTER_ID
```

This last step is deliberately manual. `set_adapter` resets the vault's adapter-share accounting to zero — if any funds are currently deposited through the vault's _current_ adapter, they become unreachable through the vault's normal withdraw flow the moment you swap. Before running the printed command:

1. Confirm no funds are at risk: `vault.get_adapter()` → that adapter's `total_assets()`. If it's non-zero, withdraw first.
2. Run the printed command using the vault's actual `ADMIN` key, not `DEPLOYER` — this call requires `admin.require_auth()`.

## Getting testnet USDC

Blend's testnet pool uses USDC issued by Blend's own controlled test key, not Circle's testnet USDC — the two are different Stellar assets that happen to share an asset code. Fund a testnet wallet from [Blend's public faucet](https://testnet.blend.capital) or via its API endpoint (`fundFromBlendFaucet()` in `apps/web/src/hooks/useVaultActions.ts` calls this automatically when a depositing wallet has no USDC balance). In practice the default faucet call reliably grants BLND/wETH/wBTC but has not reliably granted USDC in testing — if a deposit fails with a missing-trustline or insufficient-balance error, you may need to fund the wallet directly through Blend's own faucet UI.

## Run the signing flow end-to-end

With the contracts deployed and `known-pools.ts`/`constants.ts` updated:

1. Open the app, connect Freighter (testnet mode).
2. Enter a USDC amount and click **Deposit**.
3. Freighter displays the transaction details; verify the contract address matches `VAULT_CONTRACT_ID`.
4. Approve the transaction.
5. After ~5 seconds, the position summary updates with your deposited amount.
