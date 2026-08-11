# Vault Contract

The `MeridianVault` contract is a Soroban smart contract written in Rust, located at `packages/contracts/vault/src/lib.rs`. It is a protocol-agnostic coordinator: it holds no direct opinion about where funds actually earn yield. Instead it delegates all protocol-specific work to a swappable **adapter** contract (see [Adapter Contracts](#adapter-contracts) below).

## Tokens

| Token | Role                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| USDC  | Deposit and withdrawal currency. Pulled from the user on deposit, returned on withdraw.                            |
| mUSDC | Share token. Minted to the user on deposit, burned on withdraw. Represents proportional ownership of vault assets. |

Both are standard Stellar assets managed via the `TokenClient`/`StellarAssetClient` interfaces. The vault must be set as the admin of the mUSDC asset to mint and burn autonomously (the deploy scripts do this automatically — see [Testnet Deployment](../operations/testnet-deployment.md)).

## Interface

### `initialize(admin, usdc, musdc, adapter) -> Result<(), ContractError>`

Called once at deployment. Sets the admin, USDC contract address, mUSDC contract address, and the initial yield adapter address. Requires `admin.require_auth()`. Fails with `AlreadyInitialized` if called again.

### `deposit(caller, amount) -> Result<i128, ContractError>`

Transfers `amount` USDC from the caller into the vault, forwards it to the active adapter, and mints proportional mUSDC shares. Fails with `DepositsPaused` if `set_paused(true)` is in effect, `ZeroAmount` if `amount <= 0`, or `DepositTooSmall` if the amount rounds down to zero shares at the current price.

```
shares_minted = amount * (total_shares + OFFSET) / (adapter_total_assets + OFFSET)
```

`OFFSET` is a virtual liquidity constant (1,000 stroops) that makes the first-deposit price 1 share = 1 stroop while neutralising the first-depositor inflation attack: an attacker who donates USDC directly to the adapter to inflate the share price before a victim deposits recovers only a negligible fraction of the donation, making the skim strictly unprofitable (see the `inflation_attack_is_unprofitable` test). Returns the number of shares minted.

There is no `route_to` or protocol-selection parameter on `deposit`. Which protocol the funds actually reach is determined entirely by whichever adapter the vault currently has set (see `get_adapter`/`set_adapter`), not by anything the caller passes in.

Stamps `Entry(caller)` with the current ledger timestamp on the caller's first deposit. Top-ups do not reset the original entry time. Accumulates `Principal(caller)` with `amount` on every deposit.

### `withdraw(caller, shares) -> Result<i128, ContractError>`

Burns `shares` mUSDC from the caller, redeems the proportional adapter position, and returns the resulting USDC. Fails with `ZeroAmount` if `shares <= 0`, `NoSharesOutstanding` if the vault has no shares outstanding at all, `InsufficientShares` if the caller doesn't hold enough mUSDC, or `WithdrawalTooSmall` if the redemption rounds down to zero USDC.

```
adapter_shares_to_burn = shares * total_adapter_shares / total_shares
usdc_out = <whatever the adapter's withdraw() returns for that many adapter shares>
```

Reduces `Principal(caller)` proportionally. A full exit clears both `Entry(caller)` and `Principal(caller)`. Withdrawals are never blocked by `set_paused` — see [Authorization and safety rails](#authorization-and-safety-rails).

### `get_position(address) -> i128`

Returns the mUSDC balance recorded for `address` in persistent contract storage.

### `get_entry_time(address) -> u64`

Returns the ledger timestamp of the address's current deposit, or `0` if it holds no position. Cleared on a full withdrawal so a later re-deposit starts a fresh clock.

### `get_principal(address) -> i128`

Returns the address's cost basis: the net USDC it has deposited and not yet withdrawn. Yield earned off-chain is computed as `current_share_value - principal`.

### `get_total_assets() -> i128`

Returns the live USDC value of the vault's position, read directly from the active adapter's `total_assets()`. Includes yield accrued by the underlying protocol (for Blend, only as of the adapter's last `accrue()` call — see below).

### `get_total_shares() -> i128`

Returns total outstanding mUSDC shares.

### `get_adapter() -> Address`

Returns the currently active adapter contract address.

### `set_adapter(new_adapter)` (admin only)

Points the vault at a new adapter contract and resets the adapter-share counter (`ADPT_SH`) to zero. **This is the only way to change which protocol a vault routes to, or to push new adapter code live** — adapter contracts have no in-place upgrade path (no `update_current_contract_wasm`). The contract itself rejects the call with `AdapterSwapUnsafe` while the vault still has shares outstanding (`get_total_shares() > 0`), so a swap can't be made while depositors are still in the vault. The caller is still responsible for migrating funds out of the old adapter _before_ shares reach zero and calling this: any value still sitting in the old adapter becomes unreachable through the vault's normal `withdraw()` flow once the adapter-share counter resets. See `scripts/redeploy-blend-adapter.sh` for the supported procedure.

### `set_paused(paused: bool)` (admin only)

Emergency switch. While paused, new deposits are rejected. Withdrawals remain open so a pause can never trap user funds.

### `is_paused() -> bool`

Returns whether deposits are currently paused.

### `set_admin(new_admin)` (admin only)

Rotates the admin key. Lets a compromised or retired admin key be replaced without redeploying the vault.

### `get_admin() -> Address`

Returns the current admin address.

## Adapter contracts

Every adapter implements the shared `YieldAdapterInterface` trait defined in `vault/src/lib.rs`:

```rust
pub trait YieldAdapterInterface {
    fn deposit(env: Env, amount: i128) -> i128;
    fn withdraw(env: Env, shares: i128, recipient: Address) -> i128;
    fn total_assets(env: Env) -> i128;
    fn get_pool(env: Env) -> Address;
    fn get_protocol(env: Env) -> Symbol;
}
```

`get_pool()` returns the address of the underlying protocol contract the adapter wraps (a lending pool for Blend, a vault for DeFindex). `get_protocol()` returns a stable lowercase identifier (`"blend"`, `"defindex"`) for that protocol. Both exist purely for off-chain callers: they let the frontend discover live rate data (e.g. Blend's supply APY) without maintaining a config mapping that could drift out of sync if the adapter is later swapped via `set_adapter`. The vault itself never calls either.

Two adapters exist today, at `packages/contracts/blend-adapter/src/lib.rs` and `packages/contracts/defindex-adapter/src/lib.rs`.

### BlendAdapter

Supplies USDC into a Blend lending pool as collateral. `deposit()` calls the pool's `submit()` with a `REQUEST_SUPPLY` request; `withdraw()` calls `submit()` with a `REQUEST_WITHDRAW` request and has Blend deliver USDC straight to the recipient.

`total_assets()` returns a **cached** value (`TOTAL_KEY` in instance storage), not a live query — it's updated directly on every `deposit()`/`withdraw()` call, but yield accrued independently by Blend (interest on the supplied collateral) is not reflected until `accrue()` is called. `accrue()` is permissionless (anyone can call it) and refreshes the cache by reading the adapter's current bToken balance and exchange rate straight from Blend's own ledger (`get_reserve`/`get_positions`), so there's no risk of drift between the cached total and Blend's actual accounting. It should be called before any `total_assets()` read that will inform a deposit or withdrawal price.

**Auth note:** `deposit()` calls `env.authorize_as_current_contract(...)` before invoking the pool's `submit()`. This is required because Blend's pool pulls the USDC from the adapter via its own internal `token.transfer()` call — a nested invocation the pool triggers, not one the adapter makes directly. Soroban's "direct invoker" self-authorization only covers calls a contract makes itself; it does not extend to a call a _callee_ later makes on the contract's behalf several frames down the stack. Without this explicit pre-authorization, deposits fail during simulation with `HostError: Error(Auth, InvalidAction)`.

### DefindexAdapter

Deposits USDC into a DeFindex vault. `deposit()`/`withdraw()` wrap DeFindex's own `deposit`/`withdraw` vault interface. `total_assets()` is computed live on every call from DeFindex's `get_asset_amounts_per_shares`, unlike BlendAdapter's cached model — DeFindex vaults report value directly without a separate accrue step.

## Share price example

1. User A deposits 100 USDC. Vault has 0 shares, so `shares ≈ 100` (adjusted by `OFFSET`). Adapter: 100 USDC, vault: 100 shares.
2. Yield accrues (for Blend, after an `accrue()` call). Adapter's `total_assets()` now reports 110 USDC (10 USDC yield).
3. User B deposits 100 USDC. `shares = 100 * 100 / 110 ≈ 90.9`. Adapter: 210 USDC, vault: 190.9 shares.
4. User A withdraws all 100 shares. `usdc_out = 100 * 210 / 190.9 ≈ 110`. User A receives 110 USDC, profiting 10 USDC from yield.

## USDC decimal places

USDC on Stellar uses 7 decimal places. 1 USDC = `10_000_000` stroops. All contract amounts are in stroops (i128). The API converts user-facing decimal strings (e.g. `"10.50"`) to stroops before building the transaction.

## Authorization and safety rails

`caller.require_auth()` is called at the start of both `deposit` and `withdraw`. Admin functions (`set_admin`, `set_paused`, `set_adapter`) call an internal `require_admin` helper that reads the stored admin address and calls `require_auth()` on it. See [BlendAdapter's auth note](#blendadapter) above for a subtler auth requirement specific to that adapter.

Deposits, but never withdrawals, can be paused via `set_paused(true)` — this is deliberate, so a pause can never trap user funds.

## Error codes

`ContractError` (defined in `vault/src/lib.rs`) gives fallible entry points typed, stable error codes instead of panic strings:

| Variant               | Code | Meaning                                                                |
| --------------------- | ---- | ---------------------------------------------------------------------- |
| `AlreadyInitialized`  | 1    | `initialize` called on a contract that already has an admin.           |
| `NotInitialized`      | 2    | A state-mutating call was made before `initialize`.                    |
| `DepositsPaused`      | 3    | `deposit` called while `set_paused(true)` is in effect.                |
| `ZeroAmount`          | 4    | `deposit`/`withdraw` called with a non-positive amount/shares.         |
| `DepositTooSmall`     | 5    | The deposited amount rounds down to zero shares.                       |
| `NoSharesOutstanding` | 6    | `withdraw` called while the vault has no shares outstanding.           |
| `InsufficientShares`  | 7    | The caller doesn't hold enough mUSDC to burn.                          |
| `WithdrawalTooSmall`  | 8    | The shares burned round down to zero USDC.                             |
| `Overflow`            | 9    | An intermediate arithmetic operation would overflow `i128`.            |
| `AdapterSwapUnsafe`   | 10   | `set_adapter` was called while the vault still has shares outstanding. |

## Contract storage

| Key                  | Storage type | Value                                                             |
| -------------------- | ------------ | ----------------------------------------------------------------- |
| `ADMIN`              | Instance     | Admin `Address`                                                   |
| `USDC`               | Instance     | USDC contract `Address`                                           |
| `MUSDC`              | Instance     | mUSDC contract `Address`                                          |
| `ADAPTER`            | Instance     | Active adapter contract `Address`                                 |
| `TOTAL_SH`           | Instance     | Total mUSDC shares outstanding (`i128`)                           |
| `ADPT_SH`            | Instance     | Total adapter shares outstanding, reset on `set_adapter` (`i128`) |
| `PAUSED`             | Instance     | Deposit pause flag (`bool`)                                       |
| `Balance(address)`   | Persistent   | Per-address mUSDC share balance (`i128`)                          |
| `Entry(address)`     | Persistent   | Per-address deposit entry timestamp (`u64`)                       |
| `Principal(address)` | Persistent   | Per-address net USDC deposited, not yet withdrawn (`i128`)        |
