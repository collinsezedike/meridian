# Vault Contract

The `MeridianVault` contract is a Soroban smart contract written in Rust, located at `packages/contracts/vault/src/lib.rs`.

## Tokens

| Token | Role |
|---|---|
| USDC | Deposit and withdrawal currency. Pulled from the user on deposit, returned on withdraw. |
| mUSDC | Share token. Minted to the user on deposit, burned on withdraw. Represents proportional ownership of vault assets. |

Both are standard Stellar assets managed via the `TokenClient` interface. The vault must be set as the admin of the mUSDC asset to mint and burn autonomously.

## Interface

### `initialize(admin, usdc, musdc)`

Called once at deployment. Sets the admin, USDC contract address, and mUSDC contract address. Panics if called again.

### `deposit(caller, amount, route_to) -> i128`

Transfers `amount` USDC from the caller into the vault, mints proportional mUSDC shares, and records the routing protocol. Panics if deposits are paused.

```
shares_minted = amount * (total_shares + OFFSET) / (vault_balance + OFFSET)
```

At genesis (no outstanding shares), `shares = amount` (1:1). The virtual `OFFSET` (1,000 stroops) neutralises the first-depositor inflation attack: an attacker who donates USDC to inflate the share price before a victim deposits recovers only a negligible fraction of the donation, making the skim strictly unprofitable. Returns the number of shares minted.

`route_to` is a `Protocol` enum value (`Blend` or `DeFindex`), passed by the API based on the current best rate. It is stored in contract instance storage so any observer can read where funds currently sit.

Stamps `Entry(caller)` with the current ledger timestamp on the caller's first deposit. Top-ups do not reset the original entry time. Accumulates `Principal(caller)` with `amount` on every deposit.

### `withdraw(caller, shares) -> i128`

Burns `shares` mUSDC from the caller and returns proportional USDC.

```
usdc_out = shares * (vault_balance + OFFSET) / (total_shares + OFFSET)
```

The caller must hold at least `shares` mUSDC or the transaction panics with "insufficient shares". Reduces `Principal(caller)` proportionally. A full exit clears both `Entry(caller)` and `Principal(caller)`.

### `get_position(address) -> i128`

Returns the mUSDC balance recorded for `address` in persistent contract storage.

### `get_entry_time(address) -> u64`

Returns the ledger timestamp of the address's current deposit, or `0` if it holds no position. Cleared on a full withdrawal so a later re-deposit starts a fresh clock.

### `get_principal(address) -> i128`

Returns the address's cost basis: the net USDC it has deposited and not yet withdrawn. Yield earned off-chain is computed as `current_share_value - principal`.

### `get_active_protocol() -> Protocol`

Returns the protocol recorded during the last deposit.

### `get_total_assets() -> i128`

Returns the vault's current USDC balance in stroops.

### `get_total_shares() -> i128`

Returns total outstanding mUSDC shares.

### `set_paused(paused: bool)` (admin only)

Emergency switch. While paused, new deposits are rejected. Withdrawals remain open so a pause can never trap user funds.

### `is_paused() -> bool`

Returns whether deposits are currently paused.

### `set_admin(new_admin)` (admin only)

Rotates the admin key. Lets a compromised or retired admin key be replaced without redeploying the vault.

### `get_admin() -> Address`

Returns the current admin address.

## Share price example

1. User A deposits 100 USDC. Vault has 0 shares, so `shares = 100`. Vault: 100 USDC, 100 shares.
2. Yield accrues. Vault now holds 110 USDC (10 USDC yield from Blend).
3. User B deposits 100 USDC. `shares = 100 * 100 / 110 ≈ 90.9`. Vault: 210 USDC, 190.9 shares.
4. User A withdraws all 100 shares. `usdc_out = 100 * 210 / 190.9 ≈ 110`. User A receives 110 USDC, profiting 10 USDC from yield.

## USDC decimal places

USDC on Stellar uses 7 decimal places. 1 USDC = `10_000_000` stroops. All contract amounts are in stroops (i128). The API converts user-facing decimal strings (e.g. `"10.50"`) to stroops before building the transaction.

## Authorization

`caller.require_auth()` is called at the start of both `deposit` and `withdraw`. Soroban's auth framework enforces that the caller's signature covers the exact function call, preventing replay and impersonation attacks. Admin functions call an internal `require_admin` helper that reads the stored admin address and calls `require_auth()` on it.

## Contract storage

| Key | Storage type | Value |
|---|---|---|
| `ADMIN` | Instance | Admin `Address` |
| `USDC` | Instance | USDC contract `Address` |
| `MUSDC` | Instance | mUSDC contract `Address` |
| `PROTOCOL` | Instance | Last-used `Protocol` enum |
| `TOTAL_SH` | Instance | Total mUSDC shares outstanding (`i128`) |
| `PAUSED` | Instance | Deposit pause flag (`bool`) |
| `Balance(address)` | Persistent | Per-address mUSDC share balance (`i128`) |
| `Entry(address)` | Persistent | Per-address deposit entry timestamp (`u64`) |
| `Principal(address)` | Persistent | Per-address net USDC deposited, not yet withdrawn (`i128`) |
