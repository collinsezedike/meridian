# Vault Contract

The `MeridianVault` contract is a Soroban smart contract written in Rust, located at `packages/contracts/vault/src/lib.rs`. It is a protocol-agnostic coordinator: it holds no direct opinion about where funds actually earn yield. Instead it delegates all protocol-specific work to a swappable **adapter** contract (see [Adapter Contracts](#adapter-contracts) below).

## Tokens

| Token | Role                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| USDC  | Deposit and withdrawal currency. Pulled from the user on deposit, returned on withdraw.                            |
| mUSDC | Share token. Minted to the user on deposit, burned on withdraw. Represents proportional ownership of vault assets. |

USDC is a standard Stellar asset, managed via `TokenClient`. mUSDC (#578) is a **custom SEP-41 token** — `packages/contracts/musdc-token/src/lib.rs`, a separate contract this vault deploys and controls, not a Stellar Asset Contract (SAC). This is what lets it carry a transfer callback into the vault (see [Transferable shares](#transferable-shares) below); a bare SAC's `transfer` is fixed, built-in behavior with no hook a vault could add one to. The vault is set as mUSDC's admin at mUSDC's own deployment (a constructor argument, not a separate `set_admin` call — see [Testnet Deployment](../operations/testnet-deployment.md)) so it can mint and burn autonomously, and reads/writes it exactly like any other SEP-41 token via `TokenClient`.

mUSDC is a **freely transferable** share token, and the vault treats it as one: share ownership is read from the token on every call that depends on it, never from a vault-side balance map. See [Transferable shares](#transferable-shares) for what a transfer does and does not carry with it.

## Interface

### `initialize(admin, usdc, musdc, adapter) -> Result<(), ContractError>`

Called once at deployment. Sets the admin, USDC contract address, mUSDC contract address, and the initial yield adapter address. Requires `admin.require_auth()`. Fails with `AlreadyInitialized` if called again.

Unlike the adapters (see [Adapter Contracts](#adapter-contracts) below), the vault does not use a `__constructor` — it still follows the two-step `deploy` then `initialize` pattern, so a deployed-but-uninitialized vault is claimable by whoever calls `initialize` first. See the deploy scripts for how this window is closed in practice.

### `deposit(caller, amount, min_shares_out) -> Result<i128, ContractError>`

Transfers `amount` USDC from the caller into the vault, forwards it to the active adapter, and mints proportional mUSDC shares. Fails with `DepositsPaused` if `set_paused(true)` is in effect, `ZeroAmount` if `amount <= 0`, `DepositTooSmall` if the amount rounds down to zero shares at the current price, or `SlippageExceeded` if the minted shares would fall below `min_shares_out`. Callers wishing to opt out of minimum-output enforcement pass `0`.

```
shares_minted = amount * (total_shares + OFFSET) / (adapter_total_assets + OFFSET)
```

`OFFSET` is a virtual liquidity constant (1,000 stroops) that makes the first-deposit price 1 share = 1 stroop while neutralising the first-depositor inflation attack: an attacker who donates USDC directly to the adapter to inflate the share price before a victim deposits recovers only a negligible fraction of the donation, making the skim strictly unprofitable (see the `inflation_attack_is_unprofitable` test). Returns the number of shares minted.

There is no `route_to` or protocol-selection parameter on `deposit`. Which protocol the funds actually reach is determined entirely by whichever adapter the vault currently has set (see `get_adapter`/`set_adapter`), not by anything the caller passes in.

Stamps `Entry(caller)` with the current ledger timestamp on the caller's first deposit. Top-ups do not reset the original entry time. Whether a deposit is a first deposit is decided by whether an `Entry(caller)` record exists, not by the caller's share balance: an address holding mUSDC it was transferred has never deposited, so its first deposit is a real entry. Accumulates `Principal(caller)` with `amount` on every deposit.

**Known constraint — dust-position entry-time gaming:** "first deposit" here means `Balance(caller)` was `0` going in, not "no history." A partial withdrawal that leaves a non-zero dust balance (e.g. 1 stroop) does not clear `Entry(caller)` — only a full exit does (see `withdraw()` below) — so a much later, much larger top-up on that dust position is not a first deposit and inherits the original entry timestamp instead of getting a fresh one. This has no effect today: no entry point reads `Entry`/`get_entry_time` for anything but display. It becomes directly exploitable the moment any duration-gated feature (a fee discount, a loyalty multiplier, vesting) is built against raw `entry_time`. Do not build such a feature against the raw value without first switching the write path to a size-weighted average timestamp on top-up, so a large late deposit meaningfully pulls `entry_time` forward rather than inheriting the original stamp wholesale.

### `withdraw(caller, shares, min_usdc_out) -> Result<i128, ContractError>`

Burns `shares` mUSDC from the caller, redeems the proportional adapter position, and returns the resulting USDC. Fails with `ZeroAmount` if `shares <= 0`, `NoSharesOutstanding` if the vault has no shares outstanding at all, `InsufficientShares` if the caller doesn't hold enough mUSDC, `WithdrawalTooSmall` if the redemption rounds down to zero USDC, or `MinAmountOutNotMet` if the USDC redeemed is less than `min_usdc_out`. Pass `0` for `min_usdc_out` to disable the slippage guard.

The `InsufficientShares` check reads the caller's live mUSDC balance, the same balance the burn operates on, so the two can never disagree. The check is kept rather than left to the burn's own failure so callers get the typed error instead of a panic.

```
adapter_shares_to_burn = shares * total_adapter_shares / total_shares
usdc_out = <whatever the adapter's withdraw() returns for that many adapter shares>
```

Reduces `Principal(caller)` proportionally to the caller's live balance, so a holder who transferred part of their position away still retires exactly the basis for the shares they burn. A full exit clears both `Entry(caller)` and `Principal(caller)`. Withdrawals are never blocked by `set_paused` — see [Authorization and safety rails](#authorization-and-safety-rails).

### `on_transfer(from, to, amount, sender_balance_before, receiver_balance_before) -> Result<(), ContractError>`

Called by the mUSDC token contract itself, immediately after it moves a transfer's balances, to split `Principal`/`Entry` pro-rata between sender and receiver (#578). Requires mUSDC's own `require_auth()` — see [Transferable shares](#transferable-shares) for the full split math and why that check can only be satisfied by a genuine transfer on the real mUSDC contract. Not something an off-chain caller or the frontend ever invokes directly.

### `get_position(address) -> i128`

Returns the address's mUSDC balance, read from the share token itself. mUSDC received by transfer counts immediately and withdraws normally, exactly like minted shares. Returns `0` before `initialize` rather than erroring, since "no position" is the truthful answer for a vault that holds nothing yet.

### `get_entry_time(address) -> u64`

Returns the ledger timestamp of the address's current deposit, or `0` if it holds no position. Cleared on a full withdrawal so a later re-deposit starts a fresh clock, and self-heals on the next read for any address that currently holds no mUSDC, so a record left behind by a transfer-out is never shown as a live position. The one case that escapes both of these is a partial withdrawal that leaves dust; see the constraint noted under `deposit()` above. Currently read only for display; nothing on-chain or off-chain conditions behavior on it.

### `get_principal(address) -> i128`

Returns the address's cost basis: the net USDC it has deposited and not yet withdrawn. Yield earned off-chain is computed as `current_share_value - principal`. Reported as `0` for an address holding no mUSDC. An address whose shares arrived by transfer now (#578) reports the pro-rata basis it inherited via `on_transfer`, not `0` — see [Transferable shares](#transferable-shares).

### `get_total_assets() -> i128`

Returns the live USDC value of the vault's position, read directly from the active adapter's `total_assets()`. Includes yield accrued by the underlying protocol (for Blend, only as of the adapter's last `accrue()` call — see below).

### `get_total_shares() -> i128`

Returns total outstanding mUSDC shares.

### `get_adapter() -> Address`

Returns the currently active adapter contract address.

### `set_adapter(new_adapter)` (admin only)

Points the vault at a new adapter contract. **This is the only way to change which protocol a vault routes to, or to push new adapter code live** — adapter contracts have no in-place upgrade path (no `update_current_contract_wasm`). The contract itself rejects the call with `AdapterSwapUnsafe` while the vault still has shares outstanding (`get_total_shares() > 0`) **or** while the old adapter still holds a position (`ADPT_SH > 0`). Both counters are checked because they can desync: `ADPT_SH` can remain positive after `TOTAL_SH` reaches zero (see `migrate_adapter`'s `NoAdapterPosition` doc), so a `TOTAL_SH`-only check could silently strand real value at the old adapter. Use this only when the vault has no depositors yet, e.g. right after a fresh deploy. For a vault with real depositors, use `migrate_adapter` instead: unlike `set_adapter`, calling this on a live vault does not itself move any funds out of the old adapter first. `ADPT_SH` is deliberately not reset to zero on swap: the guard now guarantees it is already zero on success, and resetting it in a genuinely-empty-but-desynced vault would destroy the only evidence that a stranded position existed. See `scripts/redeploy-blend-adapter.sh` for the supported procedure.

### `begin_migration(new_adapter)` (admin only)

Phase 1 of a two-phase migration (#567). Snapshots `new_adapter`'s `total_assets()` and the current ledger sequence into instance storage (`MIG_SNAP`, `MIG_ACTIVE`). `migrate_adapter` refuses to run against `new_adapter` until at least `MIN_LEDGER_GAP` ledgers (12, ~1 minute) have elapsed since this call, so a transiently-manipulated valuation at submission time can't slip through: an observer would have to sustain the manipulation across the whole cooldown, not just the instant `migrate_adapter` executes. Fails with `SameAdapter` if `new_adapter` is the vault's current adapter, or `MigrationSnapshotAssetsInvalid` if `new_adapter.total_assets()` is negative — a negative snapshot would make `migrate_adapter`'s stability check's tolerance-scaled floor negative too, so it would pass regardless of how much the target is drained during the cooldown. Can be called repeatedly, for the same or a different adapter; each call overwrites the previous snapshot.

### `get_migration_snapshot() -> Result<MigrationSnapshot, ContractError>`

Returns the snapshot recorded by `begin_migration` (`{ adapter, total_assets, ledger_seq }`), or fails with `MigrationNotInitialized` if none is active. Off-chain callers (the migration keeper) use this to tell whether a cooldown is already in progress for a given candidate before deciding whether to call `begin_migration` or `migrate_adapter`.

### `migrate_adapter(new_adapter, max_slippage_bps) -> Result<(), ContractError>` (admin only)

Phase 2. Must be preceded by `begin_migration(new_adapter)`, with `MIN_LEDGER_GAP` ledgers elapsed since. Moves the vault's entire position from the current adapter to `new_adapter` in one atomic transaction, without requiring depositors to withdraw first. Unlike `set_adapter`, this is safe to call with shares outstanding, it's the supported way to migrate a live vault (e.g. Blend to a higher-yielding DeFindex vault, or replacing a compromised adapter).

Fails up front with `InvalidSlippageBps` if `max_slippage_bps > 10_000`, `SameAdapter` if `new_adapter` is the vault's current adapter, `NoAdapterPosition` if the current adapter has no position (`ADPT_SH <= 0`) — distinct from `NoSharesOutstanding`, which checks `TOTAL_SH` (vault mUSDC shares) instead, and the two can desync — or `MigrationNotInitialized`/`MigrationCooldownNotMet` if no matching, sufficiently-aged `begin_migration` snapshot exists for `new_adapter`.

Refreshes and reads the old adapter's `total_assets()` as the pre-migration value (an independent measurement taken before extraction, so it can catch loss on the withdrawal leg itself, not just the deposit leg), also baselines `new_adapter`'s `total_assets()` before landing any funds on it (so a pre-existing balance the target already held — e.g. residue stranded by the `set_adapter` wrong-counter case above — isn't later counted as value this migration delivered), withdraws the vault's entire adapter-share position into the vault itself, deposits it into `new_adapter`, and requires the new adapter to report a positive share count (`DepositTooSmall` otherwise, this is what stops the vault's own bookkeeping from ever being pointed at zero adapter shares while `TOTAL_SH` is still positive). Two independent checks then have to pass: a post-migration `total_assets()` delta over the pre-deposit baseline no lower than `(10_000 - max_slippage_bps) / 10_000` of the _pre-migration_ value (`MigrationValueDrift` otherwise), and the target's pre-deposit baseline itself no lower than `(10_000 - max_slippage_bps) / 10_000` of the `begin_migration` _snapshot_ value (`MigrationStabilityDrift` otherwise) — proving the target wasn't drained or manipulated during the cooldown. The second check deliberately reads the pre-deposit baseline, not the post-migration total: the post-migration total always includes the funds this call itself just delivered, so checking it against the snapshot would pass regardless of how much the target's pre-existing balance had been manipulated. `10_000` itself is a valid, if extreme, choice of `max_slippage_bps`, an admin explicitly accepting no value-preservation protection, e.g. when recovering from an old adapter already known to be broken. Since Soroban transactions are atomic, a failed check leaves no partial state, nothing moves — the `begin_migration` snapshot also survives a failed attempt and can be reused. On success, `ADAPTER`, `ADPT_SH`, and the migration snapshot are cleared; `TOTAL_SH`, every holder's mUSDC balance, and every depositor's `Principal`/`Entry` are untouched, since they're denominated in vault mUSDC shares, not adapter shares.

**This does not protect against a malicious or compromised admin key.** The admin chooses `new_adapter`, and a fake adapter could report whatever `total_assets()` it likes to pass the slippage check and then keep the funds. The invariant guards against accidental value loss (slippage, a buggy new adapter), not against the admin key itself, that's a key-custody problem (see the shared testnet admin/deployer/mUSDC-issuer key warning in the deploy scripts), not something this function can close on its own.

**The invariant's real strength also depends on how honestly the new adapter's `total_assets()` reflects what it actually holds.** `BlendAdapter::total_assets()` self-reports based on the amount `deposit()` was called with, not an independent on-chain measurement, so migrating into a `BlendAdapter` target mainly gets protection from the old-adapter-side check (independently measured before and after extraction), not from anything verifying the new `BlendAdapter` actually supplied the funds to its pool rather than just returning success.

### `set_paused(paused: bool)` (admin only)

Emergency switch. While paused, new deposits are rejected. Withdrawals remain open so a pause can never trap user funds.

### `is_paused() -> bool`

Returns whether deposits are currently paused.

### `transfer_admin(new_admin)` (admin only)

Nominates `new_admin` as the next admin. Requires the current admin's `require_auth()`. Records the nominee in a pending slot but does **not** change who the admin is — `get_admin()` still returns the current admin until the nominee itself calls `accept_admin()`. Calling this again before that happens overwrites the pending nominee; only the most recent nomination is live.

This two-step handover exists so a typo'd, unreachable, or otherwise-uncontrolled address can never brick admin: the old admin stays fully in control until the new address proves, by successfully calling `accept_admin()`, that it holds a working signing key.

### `accept_admin() -> Result<(), ContractError>` (pending nominee only)

Completes a handover previously started with `transfer_admin`. Requires the pending nominee's own `require_auth()`, not the current admin's — this is the step that proves the new key actually works. On success, `ADMIN` becomes the nominee and the pending slot is cleared. Fails with `NoPendingAdmin` if no `transfer_admin` nomination is outstanding.

### `get_pending_admin() -> Option<Address>`

Returns the currently pending nominee, or `None` if no handover is in progress.

### `get_admin() -> Address`

Returns the current admin address.

## Transferable shares

mUSDC is an ordinary transferable token, and a transfer is a legitimate thing for a holder to do: the shares are tradeable and usable as collateral elsewhere. The vault therefore keeps **one** source of truth for who owns what, the token itself.

The vault used to keep its own `Balance(address)` map alongside the token. Because a plain `transfer()` moves the real balance without touching that map, the two drifted apart and permanently stranded the position (#504): the recipient's `withdraw` failed the share check against a map that still said zero, while the sender's passed the same check and then reverted inside `burn`, because the tokens were no longer theirs. Reading ownership from the token removes the second source of truth rather than trying to keep two in step.

What a transfer carries:

|                                     | Follows the token | Why                                                       |
| ----------------------------------- | ----------------- | --------------------------------------------------------- |
| Share ownership / withdrawal rights | **Yes**           | Read from the mUSDC balance on every call                 |
| Cost basis (`Principal`)            | **Yes, pro-rata** | Split between sender and receiver on transfer (#578)      |
| Entry timestamp (`Entry`)           | **Yes, weighted** | Inherited outright, or principal-weighted averaged (#578) |

Cost basis and entry time are _history_ — what was paid and when, not a current holding — so unlike the balance they can't be derived after the fact from a snapshot; moving them with a transfer means observing the transfer as it happens. Before #578, that observation was impossible: mUSDC was a Stellar Asset Contract, and a SAC's `transfer` is the built-in implementation, with no hook and no source the vault could add one to (the vault was the SAC's _admin_ — it could mint and burn — which is not the same as controlling its code). mUSDC is now a custom SEP-41 token the vault does control the code of (`packages/contracts/musdc-token/src/lib.rs`), and its `transfer`/`transfer_from` call back into the vault's `on_transfer` after moving balances, carrying both parties' pre-transfer balances so the vault can compute the split without an extra cross-contract read.

`on_transfer`'s split, exactly matching the design proposed on #504:

- **Principal**: `principal_moved = sender_principal * amount / sender_balance_before`, subtracted from the sender and added to the receiver.
- **Entry time**: a receiver with no existing position (`receiver_balance_before == 0`) inherits the sender's entry time outright. A receiver who already holds a position gets a principal-weighted average of their existing entry time and the sender's — `(receiver_entry * receiver_principal + sender_entry * principal_moved) / (receiver_principal + principal_moved)` — so a large incoming transfer meaningfully pulls entry_time forward instead of the receiver's own original stamp swallowing it wholesale.
- A full transfer-out (`sender_balance_before - amount == 0`) clears the sender's `Entry`/`Principal` records entirely, mirroring `withdraw()`'s full-exit branch. A partial transfer-out leaves the sender's `Entry` untouched — like a partial `withdraw()`, it already reflects when they first deposited, not what they currently hold.

Security-wise, `on_transfer` requires the mUSDC token's own `require_auth()`, which Soroban satisfies automatically only when mUSDC is the _direct_ caller of that exact invocation (a contract's own direct sub-calls are inherently authorized by that contract, no signature needed) — the same direction-reversed pattern `adapter-common::require_vault_auth` already uses for every adapter to verify a call actually came from the vault. This can never be triggered by anything other than a genuine transfer on the one real, configured mUSDC contract.

**Wallet and DEX compatibility.** A custom Soroban-native SEP-41 token does not get the same classic-asset treatment mUSDC had as a SAC:

- **No classic trustline.** mUSDC as a SAC could be added to a Stellar account via a classic `ChangeTrust` operation and shown by any wallet that lists trustlines. A Soroban-native token has no trustline at all — a holding is purely a balance entry inside the token contract's own storage, visible only to something that specifically queries that contract (`balance(address)`), not to generic trustline-scanning wallet UIs.
- **No classic order book / path payments.** Classic Stellar's DEX and `PathPaymentStrictSend`/`StrictReceive` operations move classic trustline assets; they cannot touch a Soroban contract's internal balances at all. mUSDC can never appear as a classic order-book asset or a path-payment leg — only as the target of a Soroban `invoke_host_function` `transfer`/`transfer_from` call.
- **Wallet UI support is inconsistent, not absent.** Freighter, LOBSTR, and xBull can all sign an arbitrary Soroban contract-invocation transaction generically (that's what deposit/withdraw already rely on), so a user can always transfer, approve, or otherwise interact with mUSDC the same way they already interact with the vault itself. What's inconsistent is _automatic balance display_: a wallet has to specifically support SEP-41 token discovery (or hardcode mUSDC's contract address) to show a balance in its UI without the user manually adding the token; this is evolving across wallets and was not verified against current wallet versions as part of this change.

This is a real, load-bearing trade-off, not a formality: anything depending on mUSDC showing up automatically in a wallet balance list, being tradeable on the classic DEX, or reachable via a classic path payment stops working exactly as before. Nothing about depositing, withdrawing, or transferring mUSDC through the vault's own contract calls changes.

**Migration for an already-live SAC mUSDC.** If a vault has already been deployed and initialized against the old SAC-based mUSDC before this change ships to that environment, the SAC and the new SEP-41 token are two different contracts with two different balances — there is no in-place upgrade. The migration path is: deploy the new mUSDC token and a new vault instance wired to it (mirroring how [Testnet Deployment](../operations/testnet-deployment.md) already documents a vault cutover with no automatic migration of positions), snapshot every SAC mUSDC holder's balance, mint the new token 1:1 to each holder against that snapshot, and point the frontend/API at the new vault and token addresses. Existing holders on the old vault withdraw there as normal; nothing forces a cutover deadline. As of this change landing, no environment has live third-party mUSDC transfers to migrate (testnet-only, not yet used as collateral anywhere), so this is documented as the path to follow before a listing or collateral integration, not something this PR executes.

**Sequencing risk:** once mUSDC is accepted as collateral on any third-party lending market, an ordinary liquidation transfers mUSDC to a liquidator with no relationship to Meridian, turning the still-open transfer desync into unrecoverable third-party value destruction rather than a two-party problem. This adds pressure to complete the custom token migration (#504 scope) before such integrations go live.

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

### Adapter deployment and initialization

Both adapters set their vault, protocol, and USDC addresses in a `__constructor`, which the host runs inside the `CreateContract` operation that deploys the contract. Pass the arguments to `stellar contract deploy` after a `--` separator:

```bash
stellar contract deploy --network testnet --source $DEPLOYER --wasm-hash $HASH \
  -- --vault $VAULT_ID --pool $BLEND_POOL_ID --usdc $USDC_ID
```

There is no separate initialization transaction, deliberately. An adapter's `initialize()` cannot authenticate its caller (there is no deployer identity in storage yet to check against), so while deploy and initialize were two transactions, anyone watching the ledger could land `initialize()` first with their own address as `vault` and become the only party able to move funds through that adapter (#505). Adding `require_auth()` to `initialize()` would not have closed this, since it would only prove the racer controls the address they passed in. A constructor removes the intervening ledger, so there is nothing to race.

`initialize()` still exists on both adapters, so the ABI of adapters deployed from earlier WASM is unchanged and they can still be initialized by hand. On anything deployed from current WASM it always returns `AlreadyInitialized`, because the constructor has already written `VAULT_KEY`.

### BlendAdapter

Supplies USDC into a Blend lending pool as collateral. `deposit()` calls the pool's `submit()` with a `REQUEST_SUPPLY_COLLATERAL` request; `withdraw()` calls `submit()` with a `REQUEST_WITHDRAW_COLLATERAL` request and has Blend deliver USDC straight to the recipient.

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

`caller.require_auth()` is called at the start of both `deposit` and `withdraw`. Admin functions (`transfer_admin`, `set_paused`, `set_adapter`) call an internal `require_admin` helper that reads the stored admin address and calls `require_auth()` on it. `accept_admin` is one exception: it calls `require_auth()` on the pending nominee instead, since its whole purpose is to require the _new_ admin's signature, not the current one's. `on_transfer` (#578) is the other: it calls `require_auth()` on the stored mUSDC address, which only succeeds when mUSDC is the direct caller of that invocation — see [Transferable shares](#transferable-shares). See [BlendAdapter's auth note](#blendadapter) above for a subtler auth requirement specific to that adapter.

Deposits, but never withdrawals, can be paused via `set_paused(true)` — this is deliberate, so a pause can never trap user funds.

## Error codes

`ContractError` (defined in `vault/src/lib.rs`) gives fallible entry points typed, stable error codes instead of panic strings:

| Variant                          | Code | Meaning                                                                                                                                                                                           |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AlreadyInitialized`             | 1    | `initialize` called on a contract that already has an admin.                                                                                                                                      |
| `NotInitialized`                 | 2    | A state-mutating call was made before `initialize`.                                                                                                                                               |
| `DepositsPaused`                 | 3    | `deposit` called while `set_paused(true)` is in effect.                                                                                                                                           |
| `ZeroAmount`                     | 4    | `deposit`/`withdraw` called with a non-positive amount/shares.                                                                                                                                    |
| `DepositTooSmall`                | 5    | The deposited amount rounds down to zero shares, or `migrate_adapter` moved funds into a new adapter that credited zero shares.                                                                   |
| `NoSharesOutstanding`            | 6    | `withdraw` called while the vault has no shares outstanding.                                                                                                                                      |
| `InsufficientShares`             | 7    | The caller doesn't hold enough mUSDC to burn.                                                                                                                                                     |
| `WithdrawalTooSmall`             | 8    | The shares burned round down to zero USDC.                                                                                                                                                        |
| `Overflow`                       | 9    | An intermediate arithmetic operation would overflow `i128`.                                                                                                                                       |
| `AdapterSwapUnsafe`              | 10   | `set_adapter` was called while the vault still has shares outstanding.                                                                                                                            |
| `SameAdapter`                    | 11   | `migrate_adapter` was called with the vault's current adapter as the target.                                                                                                                      |
| `MigrationValueDrift`            | 12   | `migrate_adapter`'s post-migration value fell outside `max_slippage_bps` of the pre-migration value.                                                                                              |
| `NoAdapterPosition`              | 13   | `migrate_adapter` was called while the current adapter has no position (`ADPT_SH <= 0`).                                                                                                          |
| `InvalidSlippageBps`             | 14   | `migrate_adapter` was called with `max_slippage_bps > 10_000`.                                                                                                                                    |
| `MinAmountOutNotMet`             | 15   | `withdraw` was called with a `min_usdc_out` guard and the redeemed USDC fell below it. Protects callers from unexpected slippage or a price move between simulation and execution.                |
| `NoPendingAdmin`                 | 16   | `accept_admin` was called with no `transfer_admin` nomination outstanding.                                                                                                                        |
| `AdapterReportedNoAssets`        | 17   | The adapter reported zero or negative total assets while the vault still has shares outstanding.                                                                                                  |
| `SlippageExceeded`               | 18   | `deposit` output fell below caller-specified minimum bound (`min_shares_out`).                                                                                                                    |
| `MigrationNotInitialized`        | 19   | `migrate_adapter` was called without a matching `begin_migration` snapshot for the target adapter.                                                                                                |
| `MigrationCooldownNotMet`        | 20   | `migrate_adapter` was called before `MIN_LEDGER_GAP` ledgers had elapsed since `begin_migration`.                                                                                                 |
| `MigrationStabilityDrift`        | 21   | `migrate_adapter`'s target adapter's pre-deposit balance fell outside `max_slippage_bps` of the `begin_migration` snapshot, indicating the target was drained or manipulated during the cooldown. |
| `MigrationSnapshotAssetsInvalid` | 22   | `begin_migration` was called against a target adapter reporting a negative `total_assets()`.                                                                                                      |

## Contract storage

| Key                  | Storage type | Value                                                                                                                                        |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN`              | Instance     | Admin `Address`                                                                                                                              |
| `PEND_ADM`           | Instance     | Pending admin nominee `Address`, set by `transfer_admin` and cleared once `accept_admin` completes                                           |
| `USDC`               | Instance     | USDC contract `Address`                                                                                                                      |
| `MUSDC`              | Instance     | mUSDC contract `Address`                                                                                                                     |
| `ADAPTER`            | Instance     | Active adapter contract `Address`                                                                                                            |
| `TOTAL_SH`           | Instance     | Total mUSDC shares outstanding (`i128`)                                                                                                      |
| `ADPT_SH`            | Instance     | Total adapter shares outstanding. Reset to `0` on `set_adapter`; set to the new adapter's reported share count on `migrate_adapter` (`i128`) |
| `PAUSED`             | Instance     | Deposit pause flag (`bool`)                                                                                                                  |
| `Entry(address)`     | Persistent   | Per-address deposit entry timestamp (`u64`)                                                                                                  |
| `Principal(address)` | Persistent   | Per-address net USDC deposited, not yet withdrawn (`i128`)                                                                                   |
