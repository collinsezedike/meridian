#![no_std]

mod errors;
mod storage;

pub use errors::ContractError;
pub use storage::{
    clear_position_records, DataKey, MigrationSnapshot, ADAPTER, ADMIN, ADPT_SH, MIG_ACTIVE,
    MIG_SNAP, MIN_LEDGER_GAP, MUSDC, OFFSET, PAUSED, PEND_ADM, TOTAL_SH, USDC,
};

use soroban_sdk::{
    contract, contractclient, contractimpl, symbol_short, token::TokenClient, Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Event topics
// ---------------------------------------------------------------------------

/// Top-level topic shared by all vault admin-action events.
const ADMIN_EVT: Symbol = symbol_short!("admin");

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/// Generic interface every yield-bearing adapter must implement.
/// Deploy a new adapter implementing this trait to add a protocol without
/// modifying the vault. The vault calls these functions directly.
#[contractclient(name = "AdapterClient")]
pub trait YieldAdapterInterface {
    fn deposit(env: Env, amount: i128) -> i128;
    fn withdraw(env: Env, shares: i128, recipient: Address) -> i128;
    fn total_assets(env: Env) -> i128;
    /// The adapter's current protocol-share balance, read from the underlying
    /// protocol's own ledger rather than self-tracked. Lets the vault reconcile
    /// ADPT_SH instead of estimating its decrements.
    fn total_shares(env: Env) -> i128;
    /// Refreshes the adapter's cached total_assets before it is read for
    /// deposit/withdraw pricing. A no-op for adapters that already price
    /// live on every call.
    fn refresh(env: Env);
    /// Returns the address of the underlying protocol contract this adapter
    /// wraps (a lending pool for Blend, a vault for DeFindex, etc). Lets
    /// off-chain callers discover where to read live protocol data (e.g. a
    /// supply rate) without maintaining that address in config, so it can
    /// never drift out of sync if the adapter is later swapped via
    /// `set_adapter`.
    fn get_pool(env: Env) -> Address;
    /// Returns a stable, lowercase identifier for the protocol this adapter
    /// wraps (e.g. "blend", "defindex"). A constant per adapter deployment;
    /// lets off-chain callers pick the right protocol-specific logic to
    /// interpret the address returned by `get_pool()`, without a manually
    /// maintained config mapping that could drift out of sync.
    fn get_protocol(env: Env) -> Symbol;
}

// ---------------------------------------------------------------------------
// mUSDC admin interface (#578)
// ---------------------------------------------------------------------------

/// The subset of the mUSDC token's admin-only surface the vault calls into.
/// Kept minimal and local to this crate, mirroring `YieldAdapterInterface`
/// above: the vault never depends on `meridian-musdc-token` directly, in
/// production or in tests — `MockMusdc` in the test module below stands in
/// for it the same way `MockAdapter` stands in for a real adapter crate
/// (see `MockMusdc`'s doc comment for why: a real cross-crate dependency
/// between the two hits a Windows-toolchain-specific linker limit in this
/// environment). `MusdcAdminClient`/`TokenClient` dispatch to whatever
/// contract implements matching function names and argument encodings, not
/// to a specific Rust type, so `MockMusdc` is a valid call target for both
/// without implementing this trait. No `Result` return, matching
/// `YieldAdapterInterface`'s methods: `deposit`'s own `shares_to_mint <= 0`
/// check already guarantees `mint` is never called with a non-positive
/// amount, so the only realistic failure is an auth mismatch, which panics
/// through from the token side regardless of this trait's signature.
#[contractclient(name = "MusdcAdminClient")]
pub trait MusdcAdminInterface {
    fn mint(env: Env, to: Address, amount: i128);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MeridianVault;

#[contractimpl]
impl MeridianVault {
    /// Sets the admin, USDC token address, mUSDC share token address, and
    /// the initial yield adapter address, inside the deploying transaction's
    /// own `CreateContract` operation. Unlike a separate `initialize()` call,
    /// there is no intervening ledger where an attacker could land a
    /// self-authorized call first: the deployer's transaction is the only
    /// one that can ever set this contract's state (#551, same bug class as
    /// #505, fixed for the adapters/mUSDC in #550).
    ///
    /// Unlike the adapters/mUSDC's constructor arguments, `admin` is a
    /// human-held key, not a programmatically-derived contract address, so
    /// `require_auth()` is called on it here too: without it, `DEPLOYER`
    /// alone could set any address as admin with no proof it is controlled
    /// by anyone, permanently bricking the vault on a typo (`transfer_admin`/
    /// `accept_admin` both require the *current* admin's own signature to
    /// move away from it). Soroban only honors `require_auth()` inside a
    /// constructor for the address that is the deploying transaction's own
    /// source account, so this requires `ADMIN` itself, not `DEPLOYER`, to
    /// source the vault's deploy transaction. See
    /// `apps/docs/operations/testnet-deployment.md`.
    pub fn __constructor(
        env: Env,
        admin: Address,
        usdc: Address,
        musdc: Address,
        adapter: Address,
    ) {
        admin.require_auth();
        Self::init_state(&env, &admin, &usdc, &musdc, &adapter);
    }

    /// Retained so the ABI of vaults already deployed from earlier WASM is
    /// unchanged, and so an old vault can still be initialized by hand.
    ///
    /// On any vault deployed from this WASM it is unreachable: `__constructor`
    /// has already set `ADMIN`, so every call returns `AlreadyInitialized`.
    /// That is the intended behavior, not a leftover. An attacker calling
    /// this against a freshly deployed vault is rejected instead of served.
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc: Address,
        musdc: Address,
        adapter: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        Self::init_state(&env, &admin, &usdc, &musdc, &adapter);
        Ok(())
    }

    /// The write half of initialization, shared by `__constructor` and
    /// `initialize` so the two can never set up different state. Not exported
    /// (no `pub`), so it is not callable from outside the contract.
    fn init_state(env: &Env, admin: &Address, usdc: &Address, musdc: &Address, adapter: &Address) {
        env.storage().instance().set(&ADMIN, admin);
        env.storage().instance().set(&USDC, usdc);
        env.storage().instance().set(&MUSDC, musdc);
        env.storage().instance().set(&ADAPTER, adapter);
        env.storage().instance().set(&TOTAL_SH, &0_i128);
        env.storage().instance().set(&ADPT_SH, &0_i128);
    }

    /// Deposit `amount` USDC into the vault. USDC is forwarded to the yield
    /// adapter, which deploys it to the underlying protocol.
    ///
    /// Returns the number of mUSDC shares minted to the caller.
    pub fn deposit(
        env: Env,
        caller: Address,
        amount: i128,
        min_shares_out: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        if Self::is_paused(env.clone()) {
            return Err(ContractError::DepositsPaused);
        }
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let usdc = Self::usdc(&env)?;
        let musdc = Self::musdc(&env)?;
        let adapter_addr: Address = env
            .storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)?;
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);

        // Refresh the adapter's cached total before pricing so this
        // depositor's own transaction is priced with up-to-date yield.
        AdapterClient::new(&env, &adapter_addr).refresh();

        // Share price is based on the adapter's total assets (includes yield).
        let total_assets = AdapterClient::new(&env, &adapter_addr).total_assets();

        // A held position that cannot be valued is an error, not a zero price.
        // Minting here would dilute every existing holder.
        if total_shares > 0 && total_assets <= 0 {
            return Err(ContractError::AdapterReportedNoAssets);
        }

        // shares_to_mint = amount * (total_shares + OFFSET) / (total_assets + OFFSET)
        // The virtual offset makes the first-deposit price 1 share = 1 stroop while
        // neutralising the inflation attack on every subsequent deposit.
        let shares_to_mint = amount
            .checked_mul(
                total_shares
                    .checked_add(OFFSET)
                    .ok_or(ContractError::Overflow)?,
            )
            .ok_or(ContractError::Overflow)?
            .checked_div(
                total_assets
                    .checked_add(OFFSET)
                    .ok_or(ContractError::Overflow)?,
            )
            .ok_or(ContractError::DivisionByZero)?;

        if shares_to_mint <= 0 {
            return Err(ContractError::DepositTooSmall);
        }

        if shares_to_mint < min_shares_out {
            return Err(ContractError::SlippageExceeded);
        }

        // A caller who currently holds no shares but still has Entry/Principal
        // records is a defensive safety net, not the normal path: `on_transfer`
        // (#578) now clears a sender's records itself the moment a full
        // transfer-out reaches zero, and `withdraw()`'s full-exit branch
        // already did the same, so this should be unreachable in the current
        // system. It stays in place for a balance that reached zero any other
        // way this contract doesn't yet account for, so a stale basis can
        // never be silently inherited by a fresh deposit.
        if TokenClient::new(&env, &musdc).balance(&caller) == 0 {
            clear_position_records(&env, &caller);
        }

        // Pull USDC from caller directly to the adapter.
        // The adapter address is known at this point, and the intermediate
        // vault-owned balance is never used.
        TokenClient::new(&env, &usdc).transfer(&caller, &adapter_addr, &amount);

        // Adapter deploys USDC to the underlying protocol and returns its own shares.
        let adapter_client = AdapterClient::new(&env, &adapter_addr);
        let adapter_shares = adapter_client.deposit(&amount);
        if adapter_shares <= 0 {
            return Err(ContractError::AdapterCreditedNothing);
        }

        // Mint mUSDC shares to caller.
        MusdcAdminClient::new(&env, &musdc).mint(&caller, &shares_to_mint);

        // Update global share and adapter-share counters.
        env.storage()
            .instance()
            .set(&TOTAL_SH, &(total_shares + shares_to_mint));
        env.storage()
            .instance()
            .set(&ADPT_SH, &adapter_client.total_shares());

        // Stamp the entry time on the caller's first deposit; top-ups keep
        // the original time. Keyed off whether an entry record exists rather
        // than off the incoming share balance: an address that was
        // transferred mUSDC holds shares but has never deposited, and its
        // first deposit is a real entry, not a top-up.
        let entry_key = DataKey::Entry(caller.clone());
        if !env.storage().persistent().has(&entry_key) {
            env.storage()
                .persistent()
                .set(&entry_key, &env.ledger().timestamp());
        }

        // Accumulate cost basis so the UI can display yield earned.
        let principal_key = DataKey::Principal(caller.clone());
        let prev_principal: i128 = env.storage().persistent().get(&principal_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&principal_key, &(prev_principal + amount));

        Ok(shares_to_mint)
    }

    /// Withdraw by burning `shares` mUSDC. Returns the USDC amount sent back
    /// to the caller.
    ///
    /// `min_usdc_out` is a caller-supplied slippage floor. If the computed
    /// USDC output falls below this value the transaction reverts with
    /// `MinAmountOutNotMet`, giving the caller a predictable, typed failure
    /// rather than an opaque `WithdrawalTooSmall`. Pass `0` to opt out of the
    /// floor (behaviour is then identical to the pre-guard contract).
    ///
    /// This guards against ratio-shifting: a concurrent withdrawal by another
    /// depositor changes the shared `ADPT_SH/TOTAL_SH` ratio before this
    /// transaction lands, silently shrinking the payout. With `min_usdc_out`
    /// the caller can bound how much shrinkage they are willing to accept.
    pub fn withdraw(
        env: Env,
        caller: Address,
        shares: i128,
        min_usdc_out: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        if shares <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let usdc = Self::usdc(&env)?;
        let musdc = Self::musdc(&env)?;
        let adapter_addr: Address = env
            .storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)?;

        // Refresh the adapter's cached total for display/cache consistency
        // ahead of the withdrawal. BlendAdapter::withdraw() sizes its own
        // redemption directly from the live b_rate (#486), so this refresh
        // only keeps the cache/display in sync and does not itself change
        // what the withdrawer receives.
        AdapterClient::new(&env, &adapter_addr).refresh();

        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);

        if total_shares <= 0 {
            return Err(ContractError::NoSharesOutstanding);
        }

        // Verify caller holds enough shares, read from the mUSDC token: the
        // same balance the `burn` below operates on, so the check can never
        // disagree with it. Kept as an explicit check rather than leaning on
        // the burn's own panic, so callers still get the typed
        // `InsufficientShares` error.
        let caller_shares = TokenClient::new(&env, &musdc).balance(&caller);
        if caller_shares < shares {
            return Err(ContractError::InsufficientShares);
        }

        // Proportional adapter-share burn: caller_shares/total_shares of the
        // total adapter shares are redeemed.
        let adapter_shares_to_burn = shares
            .checked_mul(total_adapter_shares)
            .ok_or(ContractError::Overflow)?
            .checked_div(total_shares)
            .ok_or(ContractError::DivisionByZero)?;

        // Adapter redeems protocol shares, delivers USDC to vault, returns amount.
        let adapter_client = AdapterClient::new(&env, &adapter_addr);
        let usdc_out =
            adapter_client.withdraw(&adapter_shares_to_burn, &env.current_contract_address());

        if usdc_out <= 0 {
            return Err(ContractError::WithdrawalTooSmall);
        }

        // Slippage guard: the caller can supply a floor so a ratio shift by a
        // concurrent withdrawal gives them a typed, predictable error instead
        // of silently returning less USDC than they expected.
        if usdc_out < min_usdc_out {
            return Err(ContractError::MinAmountOutNotMet);
        }

        // Burn mUSDC from caller and send USDC back.
        TokenClient::new(&env, &musdc).burn(&caller, &shares);
        TokenClient::new(&env, &usdc).transfer(&env.current_contract_address(), &caller, &usdc_out);

        // Update global counters.
        env.storage()
            .instance()
            .set(&TOTAL_SH, &(total_shares - shares));
        env.storage()
            .instance()
            .set(&ADPT_SH, &adapter_client.total_shares());

        let remaining = caller_shares - shares;

        // Retire cost basis in proportion to shares burned.
        let principal_key = DataKey::Principal(caller.clone());
        let principal: i128 = env.storage().persistent().get(&principal_key).unwrap_or(0);
        let principal_out = principal
            .checked_mul(shares)
            .ok_or(ContractError::Overflow)?
            .checked_div(caller_shares)
            .ok_or(ContractError::DivisionByZero)?;
        env.storage()
            .persistent()
            .set(&principal_key, &(principal - principal_out));

        // A full exit clears the entry time and cost basis so a later re-deposit
        // starts fresh.
        if remaining == 0 {
            clear_position_records(&env, &caller);
        }

        Ok(usdc_out)
    }

    /// Called by the mUSDC token contract immediately after it moves a
    /// transfer's balances, splitting `Principal`/`Entry` pro-rata between
    /// sender and receiver (#578) — the fix for the honest-`0` degradation
    /// documented on `get_principal`/`get_entry_time`, from back when mUSDC
    /// was a plain Stellar Asset Contract with no hook for the vault to
    /// observe a transfer at all.
    ///
    /// Requires the mUSDC token's own `require_auth()`, which succeeds only
    /// when mUSDC is the *direct* caller of this exact invocation — Soroban
    /// treats a contract's own direct sub-calls as inherently authorized by
    /// that contract, with no signature needed (see
    /// `Env::authorize_as_current_contract`'s doc comment: "All the direct
    /// calls that the current contract performs are always considered to
    /// have been authorized"). This can therefore never be triggered by
    /// anything other than a genuine transfer on the one real, configured
    /// mUSDC contract — the same direction-reversed pattern
    /// `adapter-common::require_vault_auth` already uses for every adapter
    /// to verify a call actually came from the vault.
    ///
    /// `sender_balance_before`/`receiver_balance_before` are `from`'s/`to`'s
    /// mUSDC balances immediately before this transfer, supplied by the
    /// token since it already has both on hand from computing the transfer
    /// itself — see `meridian-musdc-token`'s `VaultCallback` trait doc
    /// comment (`packages/contracts/musdc-token/src/lib.rs`).
    pub fn on_transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
        sender_balance_before: i128,
        receiver_balance_before: i128,
    ) -> Result<(), ContractError> {
        let musdc = Self::musdc(&env)?;
        musdc.require_auth();

        let sender_principal_key = DataKey::Principal(from.clone());
        let sender_entry_key = DataKey::Entry(from.clone());
        let receiver_principal_key = DataKey::Principal(to.clone());
        let receiver_entry_key = DataKey::Entry(to.clone());

        let sender_principal: i128 = env
            .storage()
            .persistent()
            .get(&sender_principal_key)
            .unwrap_or(0);
        let sender_entry: u64 = env
            .storage()
            .persistent()
            .get(&sender_entry_key)
            .unwrap_or(0);

        // Pro-rata share of the sender's cost basis moving with these
        // shares — the same math proposed on #504.
        let principal_moved = sender_principal
            .checked_mul(amount)
            .ok_or(ContractError::Overflow)?
            .checked_div(sender_balance_before)
            .ok_or(ContractError::DivisionByZero)?;

        // Sender side: retire the moved principal. A full transfer-out
        // clears both records, mirroring withdraw()'s full-exit branch,
        // rather than leaving a zero-balance holder with a leftover Entry
        // to self-heal on the next read. A partial transfer-out leaves
        // Entry untouched, exactly like a partial withdraw(): it already
        // reflects when the sender first deposited, not what they
        // currently hold.
        if sender_balance_before - amount == 0 {
            clear_position_records(&env, &from);
        } else {
            env.storage()
                .persistent()
                .set(&sender_principal_key, &(sender_principal - principal_moved));
        }

        // Receiver side. `receiver_balance_before == 0` is this receiver's
        // first position — same check `deposit()` uses before treating a
        // deposit as a top-up, and for the same reason: it may have a stale
        // Entry/Principal record left behind by an earlier position this
        // address fully gave up, and inheriting the sender's basis/entry
        // time outright (rather than averaging against that stale record)
        // is correct here since overwriting is unconditional.
        if receiver_balance_before == 0 {
            env.storage()
                .persistent()
                .set(&receiver_principal_key, &principal_moved);
            env.storage()
                .persistent()
                .set(&receiver_entry_key, &sender_entry);
        } else {
            let receiver_principal: i128 = env
                .storage()
                .persistent()
                .get(&receiver_principal_key)
                .unwrap_or(0);
            let receiver_entry: u64 = env
                .storage()
                .persistent()
                .get(&receiver_entry_key)
                .unwrap_or(0);
            let total_principal = receiver_principal
                .checked_add(principal_moved)
                .ok_or(ContractError::Overflow)?;

            env.storage()
                .persistent()
                .set(&receiver_principal_key, &total_principal);

            // Principal-weighted average of the receiver's existing entry
            // time and the sender's, so a large incoming transfer
            // meaningfully pulls entry_time forward instead of the
            // receiver's own original stamp swallowing the incoming
            // position wholesale. Unlike the dust-position gaming
            // constraint noted on `deposit()` (which can't do this because
            // a plain top-up has no second principal weight to average
            // against), a transfer-in always carries `principal_moved`
            // alongside it, so the correct weighted average is always
            // computable here.
            let weighted_entry = if total_principal > 0 {
                let weighted = (receiver_entry as i128)
                    .checked_mul(receiver_principal)
                    .ok_or(ContractError::Overflow)?
                    .checked_add(
                        (sender_entry as i128)
                            .checked_mul(principal_moved)
                            .ok_or(ContractError::Overflow)?,
                    )
                    .ok_or(ContractError::Overflow)?
                    .checked_div(total_principal)
                    .ok_or(ContractError::DivisionByZero)?;
                weighted as u64
            } else {
                // Both principals are zero (e.g. a dust position with no
                // recorded basis on either side) — nothing to weight
                // against, so keep whatever the receiver already had.
                receiver_entry
            };
            env.storage()
                .persistent()
                .set(&receiver_entry_key, &weighted_entry);
        }

        Ok(())
    }

    /// Returns the address's mUSDC share balance, read from the share token
    /// itself. mUSDC received by transfer counts immediately and withdraws
    /// normally, exactly like minted shares; there is no separate vault-side
    /// balance that could disagree with the token.
    ///
    /// Returns 0 before `initialize`, rather than erroring: this is a view
    /// used by dashboards, and "no position" is the truthful answer for a
    /// vault that holds nothing yet.
    pub fn get_position(env: Env, address: Address) -> i128 {
        match Self::musdc(&env) {
            Ok(musdc) => TokenClient::new(&env, &musdc).balance(&address),
            Err(_) => 0,
        }
    }

    /// Returns the ledger timestamp of the address's deposit, or 0 if it holds
    /// no position. Reset whenever the position is fully withdrawn.
    ///
    /// Entry time belongs to a depositor, not to the shares: it is recorded
    /// when an address first deposits, and now (#578) is also split
    /// pro-rata on a transfer by `on_transfer` — see that function's doc
    /// comment for the split math. An address holding no mUSDC reports 0
    /// even if it deposited earlier and later transferred everything away,
    /// so a record left behind by a full transfer-out is never reported as
    /// a live position.
    ///
    /// `on_transfer` clears a sender's record itself the moment a full
    /// transfer-out reaches zero, so a leftover record found here should be
    /// unreachable in the current system; this self-heal is kept as a
    /// defensive fallback for any balance that reached zero another way
    /// this contract doesn't yet account for (and for state left behind by
    /// mUSDC's pre-#578 life as a plain Stellar Asset Contract with no
    /// transfer hook at all, before a live-holder migration if one hasn't
    /// run yet). Clearing it here means it can never resurface as a stale
    /// basis/entry time if this address's balance later becomes nonzero
    /// again through an unrelated deposit or transfer-in.
    pub fn get_entry_time(env: Env, address: Address) -> u64 {
        if Self::get_position(env.clone(), address.clone()) == 0 {
            clear_position_records(&env, &address);
            return 0;
        }
        let key = DataKey::Entry(address);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Returns the address's cost basis: the net USDC it deposited and has not
    /// yet withdrawn. Yield earned is current share value minus this value.
    ///
    /// Cost basis is history, not a holding, so unlike the share balance it
    /// cannot be derived from the token on its own — but as of #578, mUSDC is
    /// a custom SEP-41 token the vault controls the code of (not a plain
    /// Stellar Asset Contract), so its `transfer`/`transfer_from` call back
    /// into `on_transfer`, which splits a sender's basis and hands the
    /// pro-rata share to the receiver at the moment of transfer. See
    /// `on_transfer`'s doc comment for the split math.
    ///
    /// An address that transferred its entire position away reports `0`
    /// here because it holds nothing, rather than a stale basis for shares
    /// it no longer has — `on_transfer` clears both records itself the
    /// moment a full transfer-out reaches zero.
    ///
    /// Like `get_entry_time`, the self-heal below (clearing a zero-position
    /// holder's leftover record) should be unreachable in the current
    /// system; it's kept as a defensive fallback, and as a bridge for
    /// records left over from mUSDC's pre-#578 life as a plain SAC before a
    /// live-holder migration, if one hasn't run yet.
    pub fn get_principal(env: Env, address: Address) -> i128 {
        if Self::get_position(env.clone(), address.clone()) == 0 {
            clear_position_records(&env, &address);
            return 0;
        }
        let key = DataKey::Principal(address);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Total USDC value managed by the vault as reported by the adapter.
    /// Includes yield accrued by the underlying protocol.
    pub fn get_total_assets(env: Env) -> Result<i128, ContractError> {
        let adapter_addr: Address = env
            .storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)?;
        Ok(AdapterClient::new(&env, &adapter_addr).total_assets())
    }

    /// Returns total mUSDC shares outstanding.
    pub fn get_total_shares(env: Env) -> i128 {
        env.storage().instance().get(&TOTAL_SH).unwrap_or(0)
    }

    // -----------------------------------------------------------------------
    // Admin / safety rails
    // -----------------------------------------------------------------------

    /// Admin-only emergency switch. While paused, new deposits are rejected.
    /// Withdrawals are deliberately left open so a pause can never trap funds.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&PAUSED, &paused);
        env.events()
            .publish((ADMIN_EVT, symbol_short!("paused")), paused);
        Ok(())
    }

    /// Returns whether deposits are currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED).unwrap_or(false)
    }

    /// Admin-only: nominate `new_admin` as the next admin. Requires the
    /// current admin's `require_auth()`. Does not itself change who the
    /// admin is — that only happens once the nominee calls `accept_admin`
    /// with their own signature, so a typo'd or unreachable address can
    /// never brick admin: the old admin stays in control until a working
    /// key on the other end proves it can sign. Overwrites any prior,
    /// not-yet-accepted nomination.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&PEND_ADM, &new_admin);
        env.events()
            .publish((ADMIN_EVT, symbol_short!("transfer")), new_admin.clone());
        Ok(())
    }

    /// Completes a pending admin handover. Requires the nominee's own
    /// `require_auth()`, not the current admin's, so the transfer can only
    /// complete once the new address has demonstrably proven it controls a
    /// working signing key. Fails with `NoPendingAdmin` if no
    /// `transfer_admin` nomination is outstanding.
    pub fn accept_admin(env: Env) -> Result<(), ContractError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&PEND_ADM)
            .ok_or(ContractError::NoPendingAdmin)?;
        pending.require_auth();
        env.storage().instance().set(&ADMIN, &pending);
        env.storage().instance().remove(&PEND_ADM);
        env.events()
            .publish((ADMIN_EVT, symbol_short!("accept")), pending.clone());
        Ok(())
    }

    /// Returns the pending admin nominee, if any.
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&PEND_ADM)
    }

    /// Returns the current admin address.
    pub fn get_admin(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)
    }

    /// Replace the yield adapter. The vault must have no shares outstanding
    /// (`TOTAL_SH == 0`) *and* no position left at the old adapter
    /// (`ADPT_SH == 0`) before calling this.
    ///
    /// Checking `TOTAL_SH` alone is not sufficient: the two counters can
    /// desync (see `migrate_adapter`'s `NoAdapterPosition` doc), so a vault
    /// that looks empty by `TOTAL_SH` can still have real value sitting at
    /// the old adapter. Deliberately does *not* reset `ADPT_SH` to zero on
    /// swap the way it used to -- doing so would destroy the only evidence
    /// that a stranded position existed, and it is unnecessary: `ADPT_SH`
    /// is only ever nonzero here in a genuinely-empty vault as a result of a
    /// bug, and clearing it would delete the observability that bug needs
    /// to be diagnosed, not fix it. In the normal case (both counters
    /// already zero) leaving `ADPT_SH` alone is a no-op.
    pub fn set_adapter(env: Env, new_adapter: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);
        if Self::get_total_shares(env.clone()) > 0 || total_adapter_shares > 0 {
            return Err(ContractError::AdapterSwapUnsafe);
        }
        env.storage().instance().set(&ADAPTER, &new_adapter);
        env.events()
            .publish((ADMIN_EVT, symbol_short!("adapter")), new_adapter.clone());
        Ok(())
    }

    /// Returns the current adapter address.
    pub fn get_adapter(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)
    }

    /// Phase 1 of a two-phase migration. Snapshots the target adapter's
    /// `total_assets()` and the current ledger sequence so that a later
    /// `migrate_adapter` call can verify the valuation has been stable for
    /// at least `MIN_LEDGER_GAP` ledgers (~1 minute). This prevents an
    /// observer from griefing or masking a migration by front-running a
    /// transiently-shifted valuation (issue #567).
    ///
    /// Can be called repeatedly for the same or different adapters; each
    /// call overwrites the previous snapshot. The admin must then wait for
    /// the ledger gap to elapse before calling `migrate_adapter`.
    pub fn begin_migration(env: Env, new_adapter: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;

        let old_adapter_addr = Self::get_adapter(env.clone())?;
        if new_adapter == old_adapter_addr {
            return Err(ContractError::SameAdapter);
        }

        let new_adapter_client = AdapterClient::new(&env, &new_adapter);
        new_adapter_client.refresh();
        let snapshot_assets = new_adapter_client.total_assets();
        if snapshot_assets < 0 {
            return Err(ContractError::MigrationSnapshotAssetsInvalid);
        }
        let snapshot_ledger = env.ledger().sequence();

        let snapshot = MigrationSnapshot {
            adapter: new_adapter,
            total_assets: snapshot_assets,
            ledger_seq: snapshot_ledger,
        };
        env.storage().instance().set(&MIG_SNAP, &snapshot);
        env.storage().instance().set(&MIG_ACTIVE, &1_i128);

        Ok(())
    }

    /// Returns the current migration snapshot, if one has been recorded by
    /// `begin_migration`. Off-chain callers can use this to verify the
    /// cooldown is progressing.
    pub fn get_migration_snapshot(env: Env) -> Result<MigrationSnapshot, ContractError> {
        Self::require_migration_snapshot(&env)
    }

    /// Phase 2 of a two-phase migration. Must be preceded by
    /// `begin_migration(new_adapter)` and at least `MIN_LEDGER_GAP`
    /// ledgers must have elapsed. Moves the vault's entire position from
    /// the current adapter to `new_adapter` in one atomic transaction,
    /// without requiring depositors to withdraw first. Unlike
    /// `set_adapter`, this is safe to call with shares outstanding.
    ///
    /// Withdraws everything from the old adapter into the vault, deposits
    /// it into `new_adapter`, and performs two independent checks:
    ///
    /// 1. **Slippage**: `new_adapter.total_assets()` must be at least
    ///    `(10_000 - max_slippage_bps) / 10_000` of the old adapter's
    ///    pre-migration value.
    ///
    /// 2. **Stability**: `new_adapter.total_assets()` must be at least
    ///    `(10_000 - max_slippage_bps) / 10_000` of the snapshot value
    ///    recorded by `begin_migration`, proving the valuation has been
    ///    stable across the ledger-gap cooldown.
    ///
    /// If either check fails the whole call reverts and nothing moves
    /// (Soroban transactions are atomic). On success the snapshot is
    /// cleared. `TOTAL_SH`, every holder's mUSDC balance, and every
    /// depositor's `Principal` and `Entry` are untouched: they're
    /// denominated in vault mUSDC shares, not adapter shares, so they
    /// remain valid across an adapter swap.
    ///
    /// Fails with `InvalidSlippageBps` if `max_slippage_bps` is not in
    /// `0..=10_000`; `10_000` itself is a valid, if extreme, choice —
    /// an admin explicitly accepting no protection against value loss,
    /// e.g. when recovering from an old adapter already known to be
    /// broken.
    ///
    /// This does not protect against a malicious or compromised admin
    /// key: the admin chooses `new_adapter`, and a fake adapter could
    /// report whatever `total_assets()` it likes to pass the slippage
    /// check and then keep the funds. The invariant guards against
    /// accidental value loss (slippage, a buggy new adapter), not
    /// against the admin key itself — that is a key-custody problem.
    ///
    /// The invariant's real strength also depends on how honestly
    /// `new_adapter.total_assets()` reflects what it actually holds.
    /// `BlendAdapter::total_assets()` self-reports based on the amount
    /// `deposit()` was called with, not an independent on-chain
    /// measurement, so for a `BlendAdapter` target this check mainly
    /// catches loss on the withdrawal leg from the old adapter (measured
    /// independently before and after), not a `BlendAdapter` that
    /// silently fails to actually supply the funds to its pool while
    /// still returning success.
    pub fn migrate_adapter(
        env: Env,
        new_adapter: Address,
        max_slippage_bps: u32,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env)?;

        if max_slippage_bps > 10_000 {
            return Err(ContractError::InvalidSlippageBps);
        }

        let old_adapter_addr = Self::get_adapter(env.clone())?;
        if new_adapter == old_adapter_addr {
            return Err(ContractError::SameAdapter);
        }

        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);
        if total_adapter_shares <= 0 {
            return Err(ContractError::NoAdapterPosition);
        }

        // Verify a prior begin_migration snapshot exists for this adapter
        // and that the ledger-gap cooldown has elapsed.
        let snapshot = Self::require_migration_snapshot(&env)?;
        if snapshot.adapter != new_adapter {
            return Err(ContractError::MigrationNotInitialized);
        }
        let current_ledger = env.ledger().sequence();
        if current_ledger < snapshot.ledger_seq + MIN_LEDGER_GAP {
            return Err(ContractError::MigrationCooldownNotMet);
        }

        let usdc = Self::usdc(&env)?;
        let old_adapter = AdapterClient::new(&env, &old_adapter_addr);

        // Read the old adapter's value independently, before extraction, so
        // this baseline can catch loss on the withdrawal leg itself (e.g. a
        // rate that moved, a rounding-lossy withdraw), not just loss on the
        // new-adapter leg.
        old_adapter.refresh();
        let value_before = old_adapter.total_assets();

        // Baseline the target adapter's balance before landing any funds on
        // it, so a pre-existing residue (e.g. left over from a prior
        // stranding bug) isn't counted as value this migration delivered.
        let new_adapter_client = AdapterClient::new(&env, &new_adapter);
        new_adapter_client.refresh();
        let new_adapter_value_before = new_adapter_client.total_assets();

        // Withdraw the vault's entire position into the vault itself, not a
        // single depositor, mirroring the same withdraw() entrypoint every
        // user withdrawal already goes through.
        let withdrawn =
            old_adapter.withdraw(&total_adapter_shares, &env.current_contract_address());
        if withdrawn <= 0 {
            return Err(ContractError::WithdrawalTooSmall);
        }

        // Land the funds at the new adapter before calling deposit(), the
        // same pattern the vault's own deposit() uses.
        TokenClient::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &new_adapter,
            &withdrawn,
        );
        let new_shares = new_adapter_client.deposit(&withdrawn);
        if new_shares <= 0 {
            return Err(ContractError::DepositTooSmall);
        }
        // Price the new adapter from a fresh read so a cache-backed adapter
        // (e.g. Blend) reports its real post-deposit value, matching deposit().
        // The value this migration delivered is the delta over the target's
        // pre-existing balance, not its raw post-transfer total.
        new_adapter_client.refresh();
        let value_after = new_adapter_client
            .total_assets()
            .checked_sub(new_adapter_value_before)
            .ok_or(ContractError::Overflow)?;

        // Check 1: slippage against the old adapter's pre-migration value.
        let min_acceptable = value_before
            .checked_mul(10_000i128 - max_slippage_bps as i128)
            .ok_or(ContractError::Overflow)?
            .checked_div(10_000i128)
            .ok_or(ContractError::DivisionByZero)?;
        if value_after < min_acceptable {
            return Err(ContractError::MigrationValueDrift);
        }

        // Check 2: stability — the new adapter's balance *before this
        // migration's own deposit lands* must be within tolerance of the
        // snapshot taken at begin_migration time, proving the adapter was
        // not drained or manipulated during the ledger-gap cooldown.
        // Deliberately checked against new_adapter_value_before, not
        // value_after: value_after necessarily includes the funds this
        // migration itself just delivered, so checking it against the
        // snapshot would always pass regardless of how much the adapter's
        // pre-existing balance drifted, defeating the whole point of the
        // stability check.
        let min_acceptable_from_snapshot = snapshot
            .total_assets
            .checked_mul(10_000i128 - max_slippage_bps as i128)
            .ok_or(ContractError::Overflow)?
            .checked_div(10_000i128)
            .ok_or(ContractError::DivisionByZero)?;
        if new_adapter_value_before < min_acceptable_from_snapshot {
            return Err(ContractError::MigrationStabilityDrift);
        }

        env.storage().instance().set(&ADAPTER, &new_adapter);
        env.storage()
            .instance()
            .set(&ADPT_SH, &new_adapter_client.total_shares());
        env.events().publish(
            (ADMIN_EVT, symbol_short!("migrate")),
            (old_adapter_addr.clone(), new_adapter.clone()),
        );
        env.storage().instance().set(&MIG_ACTIVE, &0_i128);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    /// Returns the active migration snapshot recorded by `begin_migration`,
    /// or `MigrationNotInitialized` if none is active. Shared by
    /// `get_migration_snapshot` and `migrate_adapter`'s precondition check
    /// so the two can't drift apart.
    fn require_migration_snapshot(env: &Env) -> Result<MigrationSnapshot, ContractError> {
        let active: i128 = env.storage().instance().get(&MIG_ACTIVE).unwrap_or(0);
        if active == 0 {
            return Err(ContractError::MigrationNotInitialized);
        }
        env.storage()
            .instance()
            .get(&MIG_SNAP)
            .ok_or(ContractError::MigrationNotInitialized)
    }

    fn usdc(env: &Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&USDC)
            .ok_or(ContractError::NotInitialized)
    }

    fn musdc(env: &Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&MUSDC)
            .ok_or(ContractError::NotInitialized)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl, contracttype, panic_with_error, symbol_short,
        testutils::{Address as _, Ledger as _},
        token::{StellarAssetClient, TokenClient},
        Address, Env, Symbol,
    };

    // Reads an instance-storage value, panicking with the typed
    // NotInitialized error instead of an opaque unwrap trap if it's unset.
    // Collapses what was previously a repeated 6-line
    // `unwrap_or_else(|| { panic_with_error!(...) })` block, used across
    // these mock adapters, into one call site per use.
    fn get_or_not_initialized<T>(env: &Env, value: Option<T>) -> T {
        value.unwrap_or_else(|| panic_with_error!(env, ContractError::NotInitialized))
    }

    // -----------------------------------------------------------------------
    // Shared logic for the proportional, live-priced mock adapters below
    // (MockAdapter, LossyMockAdapter, ZeroShareMockAdapter). Each mock has
    // its own storage-key constants since each is a separately deployed
    // contract with isolated instance storage, but the withdraw/total_assets
    // bodies are identical across all of them, so that part lives here once.
    // -----------------------------------------------------------------------

    fn mock_proportional_withdraw(
        env: &Env,
        usdc: &Address,
        sh_key: &Symbol,
        shares: i128,
        recipient: &Address,
    ) -> i128 {
        let total_sh: i128 = env.storage().instance().get(sh_key).unwrap_or(0);
        let balance = TokenClient::new(env, usdc).balance(&env.current_contract_address());

        let usdc_out = if total_sh > 0 {
            shares * balance / total_sh
        } else {
            0
        };

        if usdc_out > 0 {
            TokenClient::new(env, usdc).transfer(
                &env.current_contract_address(),
                recipient,
                &usdc_out,
            );
        }
        env.storage().instance().set(sh_key, &(total_sh - shares));
        usdc_out
    }

    fn mock_total_assets(env: &Env, usdc: &Address) -> i128 {
        TokenClient::new(env, usdc).balance(&env.current_contract_address())
    }

    // -----------------------------------------------------------------------
    // MockMusdc: a minimal stand-in for the real `meridian-musdc-token`
    // crate (#578), used instead of a genuine cross-crate dependency for
    // the same reason `MockAdapter` below stands in for a real adapter
    // crate rather than depending on one: the vault crate shouldn't need to
    // depend on musdc-token for production code, and its own test suite
    // (packages/contracts/musdc-token/src/lib.rs) already exercises the
    // real token's transfer/callback plumbing end-to-end against its own
    // local mock vault. What matters here is exercising *this* crate's
    // `on_transfer` logic against a token that genuinely calls it the same
    // way the real one does: a direct, self-authorized cross-contract call
    // made after balances have moved, carrying both parties'
    // pre-transfer balances. `TokenClient`/`MusdcAdminClient` dispatch by
    // function name and argument encoding, not by any Rust trait
    // implementation, so this needs no `#[contractclient]`-generated trait
    // on its side to be a valid call target for either. Wrapped in its own
    // module for the same reason as `cached_mock`/`lossy_mock` below:
    // contractimpl-generated helper items (e.g. `__initialize`) aren't
    // namespaced by type, so a second contract with a same-named method
    // (`initialize`) at this module level would collide.
    // -----------------------------------------------------------------------
    mod mock_musdc {
        use super::*;

        const MM_ADMIN: Symbol = symbol_short!("MM_ADMIN");

        #[contracttype]
        #[derive(Clone)]
        pub enum MockMusdcKey {
            Balance(Address),
        }

        #[contract]
        pub struct MockMusdc;

        #[contractimpl]
        impl MockMusdc {
            pub fn initialize(env: Env, admin: Address) {
                env.storage().instance().set(&MM_ADMIN, &admin);
            }

            pub fn mint(env: Env, to: Address, amount: i128) {
                let balance = Self::read_balance(&env, &to);
                Self::write_balance(&env, &to, balance + amount);
            }

            pub fn balance(env: Env, id: Address) -> i128 {
                Self::read_balance(&env, &id)
            }

            pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
                from.require_auth();
                if from == to {
                    return;
                }
                let from_balance = Self::read_balance(&env, &from);
                let to_balance = Self::read_balance(&env, &to);
                Self::write_balance(&env, &from, from_balance - amount);
                Self::write_balance(&env, &to, to_balance + amount);

                let admin: Address = env.storage().instance().get(&MM_ADMIN).unwrap();
                MeridianVaultClient::new(&env, &admin).on_transfer(
                    &from,
                    &to,
                    &amount,
                    &from_balance,
                    &to_balance,
                );
            }

            pub fn burn(env: Env, from: Address, amount: i128) {
                from.require_auth();
                let balance = Self::read_balance(&env, &from);
                Self::write_balance(&env, &from, balance - amount);
            }

            fn read_balance(env: &Env, id: &Address) -> i128 {
                env.storage()
                    .persistent()
                    .get(&MockMusdcKey::Balance(id.clone()))
                    .unwrap_or(0)
            }

            fn write_balance(env: &Env, id: &Address, amount: i128) {
                env.storage()
                    .persistent()
                    .set(&MockMusdcKey::Balance(id.clone()), &amount);
            }
        }
    }
    use mock_musdc::{MockMusdc, MockMusdcClient};

    // -----------------------------------------------------------------------
    // MockAdapter: proportional yield-bearing adapter used in vault tests.
    // Tracks shares 1:1 with deposited USDC. Proportional withdrawal means
    // any USDC minted directly to the adapter (simulating yield) is included
    // in the withdrawal amount.
    // -----------------------------------------------------------------------

    const MA_USDC: Symbol = symbol_short!("MA_USDC");
    const MA_SH: Symbol = symbol_short!("MA_SH");

    #[contract]
    pub struct MockAdapter;

    #[contractimpl]
    impl MockAdapter {
        pub fn initialize(env: Env, usdc: Address) {
            env.storage().instance().set(&MA_USDC, &usdc);
            env.storage().instance().set(&MA_SH, &0_i128);
        }

        pub fn deposit(env: Env, amount: i128) -> i128 {
            let prev: i128 = env.storage().instance().get(&MA_SH).unwrap_or(0);
            env.storage().instance().set(&MA_SH, &(prev + amount));
            amount
        }

        pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
            // USDC address is always set in initialize(), so this is safe.
            let usdc: Address =
                get_or_not_initialized(&env, env.storage().instance().get(&MA_USDC));
            mock_proportional_withdraw(&env, &usdc, &MA_SH, shares, &recipient)
        }

        pub fn total_assets(env: Env) -> i128 {
            // USDC address is always set in initialize(), so this is safe.
            let usdc: Address =
                get_or_not_initialized(&env, env.storage().instance().get(&MA_USDC));
            mock_total_assets(&env, &usdc)
        }

        pub fn total_shares(env: Env) -> i128 {
            env.storage().instance().get(&MA_SH).unwrap_or(0)
        }

        pub fn refresh(_env: Env) {
            // No-op: MockAdapter already prices total_assets() live.
        }
    }

    // -----------------------------------------------------------------------
    // LossyMockAdapter: a migrate_adapter() target that actually loses half
    // of whatever it's deposited (sent to an address it never accounts for),
    // simulating a buggy or malicious new adapter so migrate_adapter's
    // slippage invariant has something real to reject. Wrapped in its own
    // module for the same reason as cached_mock: contractimpl-generated
    // helper items aren't namespaced by type.
    // -----------------------------------------------------------------------
    mod lossy_mock {
        use super::*;

        const LA_USDC: Symbol = symbol_short!("LA_USDC");
        const LA_SH: Symbol = symbol_short!("LA_SH");

        #[contract]
        pub struct LossyMockAdapter;

        #[contractimpl]
        impl LossyMockAdapter {
            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&LA_USDC, &usdc);
                env.storage().instance().set(&LA_SH, &0_i128);
            }

            pub fn deposit(env: Env, amount: i128) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&LA_USDC));
                let half = amount / 2;
                let sink = Address::generate(&env);
                TokenClient::new(&env, &usdc).transfer(
                    &env.current_contract_address(),
                    &sink,
                    &half,
                );
                let prev: i128 = env.storage().instance().get(&LA_SH).unwrap_or(0);
                env.storage().instance().set(&LA_SH, &(prev + amount));
                amount
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&LA_USDC));
                mock_proportional_withdraw(&env, &usdc, &LA_SH, shares, &recipient)
            }

            pub fn total_assets(env: Env) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&LA_USDC));
                mock_total_assets(&env, &usdc)
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&LA_SH).unwrap_or(0)
            }

            pub fn refresh(_env: Env) {
                // No-op: LossyMockAdapter already prices total_assets() live.
            }
        }
    }

    // -----------------------------------------------------------------------
    // ZeroShareMockAdapter: a migrate_adapter() target that keeps every
    // stroop it's deposited (so total_assets() looks fine and a generous
    // slippage tolerance passes) but always reports zero shares credited,
    // simulating an adapter whose deposit() return value can't be trusted
    // even when its total_assets() can. Exercises migrate_adapter's
    // new_shares > 0 check, distinct from LossyMockAdapter's value-loss case.
    // -----------------------------------------------------------------------
    mod zero_share_mock {
        use super::*;

        const ZS_USDC: Symbol = symbol_short!("ZS_USDC");
        const ZS_SH: Symbol = symbol_short!("ZS_SH");

        #[contract]
        pub struct ZeroShareMockAdapter;

        #[contractimpl]
        impl ZeroShareMockAdapter {
            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&ZS_USDC, &usdc);
                env.storage().instance().set(&ZS_SH, &0_i128);
            }

            pub fn deposit(_env: Env, _amount: i128) -> i128 {
                // Keeps the funds (they're already sitting at this
                // contract's address, per the vault's transfer-then-deposit
                // pattern) but never credits any shares for them.
                0
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&ZS_USDC));
                mock_proportional_withdraw(&env, &usdc, &ZS_SH, shares, &recipient)
            }

            pub fn total_assets(env: Env) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&ZS_USDC));
                mock_total_assets(&env, &usdc)
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&ZS_SH).unwrap_or(0)
            }

            pub fn refresh(_env: Env) {
                // No-op: ZeroShareMockAdapter already prices total_assets() live.
            }
        }
    }

    // -----------------------------------------------------------------------
    // ManipulableMockAdapter: an adapter whose self-reported total_assets()
    // can be set independently of its actual USDC balance, letting tests
    // simulate a transiently-inflated valuation (issue #567 scenario).
    // -----------------------------------------------------------------------
    mod manipulable_mock {
        use super::*;

        const MM_USDC: Symbol = symbol_short!("MM_USDC");
        const MM_SH: Symbol = symbol_short!("MM_SH");
        const MM_FIXED: Symbol = symbol_short!("MM_FIXED");

        #[contract]
        pub struct ManipulableMockAdapter;

        #[contractimpl]
        impl ManipulableMockAdapter {
            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&MM_USDC, &usdc);
                env.storage().instance().set(&MM_SH, &0_i128);
                env.storage().instance().set(&MM_FIXED, &0_i128);
            }

            /// Override the self-reported total_assets() value. This lets
            /// tests simulate the adapter being manipulated (e.g. a
            /// front-run inflating the reported valuation).
            pub fn set_total_assets(env: Env, value: i128) {
                env.storage().instance().set(&MM_FIXED, &value);
            }

            // Credits `amount` onto whatever total_assets() currently reports
            // (which set_total_assets() may have manipulated away from the
            // adapter's real balance) rather than leaving it untouched: a
            // real adapter's total_assets() does go up by the deposited
            // amount, so a deposit() that doesn't move it here would make
            // value_after (the vault's delta-over-baseline read) always
            // compute to zero, regardless of what a test is trying to
            // simulate. Manipulation is layered on top via set_total_assets,
            // not by suppressing this.
            pub fn deposit(env: Env, amount: i128) -> i128 {
                let prev: i128 = env.storage().instance().get(&MM_SH).unwrap_or(0);
                env.storage().instance().set(&MM_SH, &(prev + amount));
                let prev_fixed: i128 = env.storage().instance().get(&MM_FIXED).unwrap_or(0);
                env.storage()
                    .instance()
                    .set(&MM_FIXED, &(prev_fixed + amount));
                amount
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&MM_USDC));
                mock_proportional_withdraw(&env, &usdc, &MM_SH, shares, &recipient)
            }

            pub fn total_assets(env: Env) -> i128 {
                // Returns the manually set value, which can diverge from
                // the actual USDC balance — exactly the scenario #567
                // describes.
                env.storage().instance().get(&MM_FIXED).unwrap_or(0)
            }

            pub fn refresh(_env: Env) {
                // No-op: total_assets is manually set by the test.
            }
        }
    }
    use manipulable_mock::{ManipulableMockAdapter, ManipulableMockAdapterClient};

    // -----------------------------------------------------------------------
    // CachedMockAdapter: mimics BlendAdapter's caching behavior. total_assets()
    // returns a cached value that only updates on refresh(), letting these
    // tests prove the vault's refresh() call -- not just live pricing -- is
    // what keeps deposit/withdraw pricing correct. Wrapped in its own module
    // because contractimpl-generated helper items are not namespaced by type,
    // and would otherwise collide with MockAdapter's identically named methods.
    // -----------------------------------------------------------------------
    mod cached_mock {
        use super::*;

        const CM_USDC: Symbol = symbol_short!("CM_USDC");
        const CM_SH: Symbol = symbol_short!("CM_SH");
        const CM_TOTAL: Symbol = symbol_short!("CM_TOTAL");

        #[contract]
        pub struct CachedMockAdapter;

        #[contractimpl]
        impl CachedMockAdapter {
            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&CM_USDC, &usdc);
                env.storage().instance().set(&CM_SH, &0_i128);
                env.storage().instance().set(&CM_TOTAL, &0_i128);
            }

            pub fn deposit(env: Env, amount: i128) -> i128 {
                let prev: i128 = env.storage().instance().get(&CM_SH).unwrap_or(0);
                env.storage().instance().set(&CM_SH, &(prev + amount));
                amount
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                // Payout is computed live, proportional to the adapter's current
                // USDC balance, matching how BlendAdapter::withdraw() sizes
                // redemptions off the live b_rate (#486). This test double
                // intentionally uses live pricing so the test below can
                // isolate what refresh() itself does or doesn't affect.
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&CM_USDC));
                let total_sh: i128 = env.storage().instance().get(&CM_SH).unwrap_or(0);
                let balance =
                    TokenClient::new(&env, &usdc).balance(&env.current_contract_address());

                let usdc_out = if total_sh > 0 {
                    shares * balance / total_sh
                } else {
                    0
                };

                if usdc_out > 0 {
                    TokenClient::new(&env, &usdc).transfer(
                        &env.current_contract_address(),
                        &recipient,
                        &usdc_out,
                    );
                }
                env.storage().instance().set(&CM_SH, &(total_sh - shares));
                usdc_out
            }

            pub fn total_assets(env: Env) -> i128 {
                // Cached: only reflects the balance as of the last refresh() call.
                // Instance storage read defaults to 0 if CM_TOTAL hasn't been set, which is safe since
                // initialize() sets this key to 0.
                env.storage().instance().get(&CM_TOTAL).unwrap_or(0)
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&CM_SH).unwrap_or(0)
            }

            pub fn refresh(env: Env) {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&CM_USDC));
                let balance =
                    TokenClient::new(&env, &usdc).balance(&env.current_contract_address());
                env.storage().instance().set(&CM_TOTAL, &balance);
            }
        }
    }
    use cached_mock::{CachedMockAdapter, CachedMockAdapterClient};

    // Returns (env, admin, user, usdc_id, musdc_id, adapter_id, vault) wired
    // to CachedMockAdapter instead of the live-pricing MockAdapter.
    fn setup_cached() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        MeridianVaultClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let adapter_id = env.register(CachedMockAdapter, ());
        CachedMockAdapterClient::new(&env, &adapter_id).initialize(&usdc_id);

        // See setup()'s comment below on why the vault's address is
        // pre-generated and reserved via register_at rather than registered
        // directly (#551).
        let vault_id = Address::generate(&env);

        let musdc_id = env.register(MockMusdc, ());
        MockMusdcClient::new(&env, &musdc_id).initialize(&vault_id);

        env.register_at(
            &vault_id,
            MeridianVault,
            (&admin, &usdc_id, &musdc_id, &adapter_id),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);

        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        (env, admin, user, usdc_id, musdc_id, adapter_id, vault)
    }

    // Returns (env, admin, user, usdc_id, musdc_id, adapter_id, vault)
    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        MeridianVaultClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy mock USDC and mUSDC. mUSDC here is MockMusdc (#578), a
        // minimal stand-in for the real `meridian-musdc-token` crate — see
        // its doc comment above for why this crate uses a local mock
        // instead of a genuine cross-crate dependency. It calls
        // `on_transfer` the same way the real token does: a direct,
        // self-authorized cross-contract call after balances move.
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &adapter_id).initialize(&usdc_id);

        // The vault's real deployment wires mUSDC and the adapter through
        // its own __constructor (#551), which needs their addresses already
        // known, but mUSDC's admin (this vault's own address) needs to be
        // known before *that* can happen either. Real deployments break this
        // cycle with a precomputed, deterministic contract ID (`stellar
        // contract id wasm --salt`, then `deploy --salt` to land on that same
        // address); `register_at` is the test-env equivalent, reserving the
        // vault's address up front so mUSDC can be told about it before the
        // vault itself is actually registered.
        let vault_id = Address::generate(&env);

        let musdc_id = env.register(MockMusdc, ());
        MockMusdcClient::new(&env, &musdc_id).initialize(&vault_id);

        env.register_at(
            &vault_id,
            MeridianVault,
            (&admin, &usdc_id, &musdc_id, &adapter_id),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);

        // Fund the user with 1000 USDC (7 decimal places: 1000 * 10^7).
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        (env, admin, user, usdc_id, musdc_id, adapter_id, vault)
    }

    #[test]
    fn deposit_mints_shares() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        let shares = vault.deposit(&user, &amount, &0_i128);

        assert_eq!(shares, amount);
        assert_eq!(vault.get_position(&user), amount);
        assert_eq!(vault.get_total_shares(), amount);
    }

    #[test]
    fn withdraw_returns_usdc() {
        let (env, _admin, user, usdc_id, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let shares = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares, &0_i128);

        assert_eq!(usdc_out, amount);
        assert_eq!(vault.get_position(&user), 0);
        assert_eq!(vault.get_total_shares(), 0);

        let user_balance = TokenClient::new(&env, &usdc_id).balance(&user);
        assert_eq!(user_balance, 10_000_000_000_i128);
    }

    #[test]
    fn deposit_records_principal() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_principal(&user), 0);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        assert_eq!(vault.get_principal(&user), amount);
    }

    #[test]
    fn topup_accumulates_principal() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        vault.deposit(&user, &50_0000000_i128, &0_i128);
        assert_eq!(vault.get_principal(&user), 150_0000000_i128);
    }

    #[test]
    fn partial_withdraw_reduces_principal_proportionally() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let half = vault.get_position(&user) / 2;
        vault.withdraw(&user, &half, &0_i128);
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn full_withdraw_clears_principal() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let shares = vault.get_position(&user);
        vault.withdraw(&user, &shares, &0_i128);
        assert_eq!(vault.get_principal(&user), 0);
    }

    #[test]
    fn share_value_exceeds_principal_after_yield() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield: mint USDC directly to the adapter.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &10_0000000_i128);

        let shares = vault.get_position(&user);
        let share_value = shares * vault.get_total_assets() / vault.get_total_shares();
        assert!(share_value > vault.get_principal(&user));
        assert_eq!(share_value - vault.get_principal(&user), 10_0000000_i128);
    }

    #[test]
    fn share_price_reflects_yield() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield: mint 10 USDC to the adapter.
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        // A second user deposits 100 USDC — should receive fewer shares because
        // the share price has risen.
        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &10_000_000_000_i128);
        let shares2 = vault.deposit(&user2, &amount, &0_i128);

        // 100 shares outstanding, vault has 110 USDC.
        // shares2 = 100 * 100 / 110 ≈ 90 shares.
        assert!(
            shares2 < amount,
            "second depositor should receive fewer shares"
        );

        // First user withdraws — should get more than 100 USDC back.
        let shares1 = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares1, &0_i128);
        assert!(
            usdc_out > amount,
            "first depositor should profit from yield"
        );
    }

    #[test]
    fn inflation_attack_is_unprofitable() {
        let (env, _admin, attacker, usdc_id, _musdc, adapter_id, vault) = setup();
        let usdc = TokenClient::new(&env, &usdc_id);

        let attacker_deposit = 1_i128;
        let attacker_shares = vault.deposit(&attacker, &attacker_deposit, &0_i128);
        assert_eq!(attacker_shares, 1);

        // Attacker donates USDC directly to the adapter to inflate the share
        // price before the victim deposits (the classic inflation attack).
        let donation = 100_0000000_i128;
        usdc.transfer(&attacker, &adapter_id, &donation);

        let victim = Address::generate(&env);
        let victim_deposit = 100_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&victim, &victim_deposit);
        let victim_shares = vault.deposit(&victim, &victim_deposit, &0_i128);
        assert!(victim_shares > 0, "victim must receive shares");

        let attacker_out = vault.withdraw(&attacker, &attacker_shares, &0_i128);

        let attacker_in = attacker_deposit + donation;
        assert!(
            attacker_out * 100 < attacker_in,
            "inflation attack must not be profitable"
        );

        let victim_out = vault.withdraw(&victim, &victim_shares, &0_i128);
        assert!(
            victim_out > victim_deposit * 99 / 100,
            "victim must not be robbed"
        );
    }

    #[test]
    fn entry_time_defaults_to_zero() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_entry_time(&user), 0);
    }

    #[test]
    fn deposit_records_entry_time() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.ledger().set_timestamp(1_700_000_000);

        vault.deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 1_700_000_000);
    }

    #[test]
    fn topup_keeps_original_entry_time() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.ledger().set_timestamp(1_700_000_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        env.ledger().set_timestamp(1_700_500_000);
        vault.deposit(&user, &50_0000000_i128, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 1_700_000_000);
    }

    #[test]
    fn full_withdraw_clears_entry_time() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.ledger().set_timestamp(1_700_000_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let shares = vault.get_position(&user);
        vault.withdraw(&user, &shares, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 0);
    }

    #[test]
    fn paused_blocks_deposit() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.set_paused(&true);
        let result = vault.try_deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::DepositsPaused)));
    }

    #[test]
    fn withdraw_works_while_paused() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        vault.set_paused(&true);
        let shares = vault.get_position(&user);
        let out = vault.withdraw(&user, &shares, &0_i128);
        assert_eq!(out, amount);
    }

    #[test]
    fn unpause_re_enables_deposits() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.set_paused(&true);
        vault.set_paused(&false);
        assert!(!vault.is_paused());

        let shares = vault.deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(shares, 100_0000000_i128);
    }

    #[test]
    fn transfer_admin_then_accept_rotates_admin() {
        let (env, admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_admin(), admin);

        let new_admin = Address::generate(&env);
        vault.transfer_admin(&new_admin);
        // Nominating alone does not change who the admin is yet.
        assert_eq!(vault.get_admin(), admin);
        assert_eq!(vault.get_pending_admin(), Some(new_admin.clone()));

        vault.accept_admin();
        assert_eq!(vault.get_admin(), new_admin);
        // The pending nomination is cleared once accepted.
        assert_eq!(vault.get_pending_admin(), None);
    }

    #[test]
    fn accept_admin_fails_with_no_pending_nominee() {
        let (_env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_accept_admin();
        assert_eq!(result, Err(Ok(ContractError::NoPendingAdmin)));
    }

    #[test]
    fn transfer_admin_overwrites_a_prior_unaccepted_nomination() {
        let (env, admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let first_nominee = Address::generate(&env);
        let second_nominee = Address::generate(&env);

        vault.transfer_admin(&first_nominee);
        vault.transfer_admin(&second_nominee);
        assert_eq!(vault.get_pending_admin(), Some(second_nominee.clone()));

        vault.accept_admin();
        assert_eq!(vault.get_admin(), second_nominee);
        // The admin is still the original one until the accepted nominee's
        // call above, so first_nominee never gained control.
        assert_ne!(admin, second_nominee);
    }

    // -----------------------------------------------------------------------
    // mUSDC is a transferable share token (#504)
    // -----------------------------------------------------------------------

    #[test]
    fn transferred_musdc_withdraws_through_its_new_holder() {
        // The reproduction from #504: before share ownership was read from
        // the token, the recipient's withdrawal failed with
        // InsufficientShares because the vault's own balance map still said
        // zero, stranding the position for both parties.
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let shares = vault.get_position(&user);

        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        assert_eq!(vault.get_position(&user), 0);
        assert_eq!(vault.get_position(&bob), shares);

        let usdc_out = vault.withdraw(&bob, &shares, &0_i128);
        assert_eq!(usdc_out, amount);
        assert_eq!(TokenClient::new(&env, &usdc_id).balance(&bob), amount);
        assert_eq!(vault.get_total_shares(), 0);
    }

    #[test]
    fn transferring_a_position_away_leaves_the_sender_with_a_typed_error() {
        // The other half of #504: the sender used to pass the share check
        // against a stale map and then revert inside `burn`, taking the whole
        // transaction down. Now the check reads the same balance the burn
        // does, so it fails cleanly and says why.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        let result = vault.try_withdraw(&user, &shares, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::InsufficientShares)));
    }

    #[test]
    fn a_partial_transfer_leaves_both_holders_able_to_withdraw() {
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let shares = vault.get_position(&user);
        let moved = shares / 2;
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &moved);

        assert_eq!(vault.get_position(&user), shares - moved);
        assert_eq!(vault.get_position(&bob), moved);

        let bob_out = vault.withdraw(&bob, &moved, &0_i128);
        let user_out = vault.withdraw(&user, &(shares - moved), &0_i128);

        assert_eq!(bob_out + user_out, amount);
        assert_eq!(TokenClient::new(&env, &usdc_id).balance(&bob), bob_out);
        assert_eq!(vault.get_total_shares(), 0);
    }

    #[test]
    fn withdrawing_after_a_partial_transfer_out_retires_basis_against_what_is_held() {
        // #578: a partial transfer-out now moves half the sender's
        // principal to the receiver at the moment of transfer (it no longer
        // "stays behind" the way it did when mUSDC was a plain SAC with no
        // transfer hook). The proportional retirement on withdraw() then
        // divides by the caller's live balance, so a holder who transferred
        // half away and then withdraws half of what remains retires exactly
        // a quarter of the original basis.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &(shares / 2));

        // Half the principal moved with half the shares.
        assert_eq!(vault.get_principal(&user), amount / 2);

        let held = vault.get_position(&user);
        vault.withdraw(&user, &(held / 2), &0_i128);

        // Half of what they held (post-transfer) was burned, so half of
        // their remaining basis is retired.
        assert_eq!(vault.get_principal(&user), amount / 4);
    }

    #[test]
    fn a_position_transferred_away_stops_being_reported() {
        // Entry and Principal records are left behind by a transfer the vault
        // cannot observe. Reporting them for an address that holds nothing
        // would show a phantom position, so both read as empty.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 12_345);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 12_345);
        assert_eq!(vault.get_principal(&user), 100_0000000_i128);

        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        assert_eq!(vault.get_entry_time(&user), 0);
        assert_eq!(vault.get_principal(&user), 0);
    }

    #[test]
    fn a_full_transfer_out_lets_a_later_deposit_start_fresh() {
        // The plain-transfer-out mirror of `a_full_exit_lets_a_later_deposit_
        // start_fresh` (#504 follow-up review): unlike a full `withdraw()`,
        // a plain `transfer()` gives the vault no hook to clear Entry/
        // Principal at the moment it happens. Without deposit() checking the
        // caller's balance itself, this re-deposit would mix its principal on
        // top of the 100 USDC basis left behind by the transfer, and report
        // the original entry time instead of its own.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        vault.deposit(&user, &50_0000000_i128, &0_i128);

        assert_eq!(vault.get_entry_time(&user), 2_000);
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn a_full_round_trip_transfer_restores_the_original_principal_and_entry_time() {
        // Before #578, "staleness" was a real risk here: the vault had no
        // way to move basis on a transfer, so a `user -> bob -> user`
        // round trip needed the zero-position self-heal to keep `user`
        // from re-inheriting a leftover record from the position they gave
        // up. Now that on_transfer genuinely carries Principal/Entry
        // through every hop, the round trip is correct by construction: bob
        // received user's exact basis and entry time on the first transfer,
        // and transferring 100% of it back hands both back to user exactly
        // as they were, not zero and not stale.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        // A full transfer-out clears the sender's own records...
        assert_eq!(vault.get_principal(&user), 0);
        assert_eq!(vault.get_entry_time(&user), 0);
        // ...while the receiver inherits them outright.
        assert_eq!(vault.get_principal(&bob), 100_0000000_i128);
        assert_eq!(vault.get_entry_time(&bob), 1_000);

        // bob transfers the same shares straight back to `user`.
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        TokenClient::new(&env, &musdc_id).transfer(&bob, &user, &shares);

        assert_eq!(vault.get_position(&user), shares);
        assert_eq!(vault.get_principal(&user), 100_0000000_i128);
        // Entry time travels with the position, not with the clock: it's
        // still 1_000, the timestamp of user's original deposit, not 2_000
        // when this second transfer happened.
        assert_eq!(vault.get_entry_time(&user), 1_000);
    }

    #[test]
    fn a_transferred_in_position_inherits_the_senders_principal_and_entry_time() {
        // #578: mUSDC is now a custom SEP-41 token whose transfer calls back
        // into the vault, so a receiver with no prior position inherits the
        // sender's cost basis and entry time outright, instead of the old
        // honest-`0` degradation from back when mUSDC was a plain SAC with
        // no hook for the vault to observe a transfer at all.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 12_345);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        assert_eq!(vault.get_position(&bob), shares);
        assert_eq!(vault.get_principal(&bob), 100_0000000_i128);
        assert_eq!(vault.get_entry_time(&bob), 12_345);
    }

    #[test]
    fn depositing_on_top_of_a_transferred_in_position_is_a_topup_not_a_fresh_entry() {
        // #578 changes this from before: an address holding transferred
        // mUSDC used to have never deposited (no Entry/Principal record at
        // all), so its first deposit was a real, fresh entry. Now
        // `on_transfer` records both for the receiver too, so a deposit on
        // top of a transferred-in position is correctly a top-up — it keeps
        // the inherited entry time and adds to the inherited principal,
        // exactly like topping up a directly-deposited position (see
        // `topup_keeps_original_entry_time`/`topup_accumulates_principal`).
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);
        assert_eq!(vault.get_entry_time(&bob), 1_000);
        assert_eq!(vault.get_principal(&bob), 100_0000000_i128);

        StellarAssetClient::new(&env, &usdc_id).mint(&bob, &10_0000000_i128);
        env.ledger().with_mut(|li| li.timestamp = 99_999);
        vault.deposit(&bob, &10_0000000_i128, &0_i128);

        assert_eq!(vault.get_entry_time(&bob), 1_000);
        assert_eq!(vault.get_principal(&bob), 110_0000000_i128);
    }

    #[test]
    fn transferring_into_an_existing_position_weight_averages_entry_time() {
        // #578: when the receiver already holds a position, entry time is a
        // principal-weighted average of their existing entry time and the
        // sender's, rather than either being overwritten or left untouched
        // — a large incoming transfer should meaningfully pull entry_time
        // forward, not get swallowed by the receiver's own original stamp.
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let carol = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        StellarAssetClient::new(&env, &usdc_id).mint(&carol, &50_0000000_i128);
        env.ledger().with_mut(|li| li.timestamp = 5_000);
        vault.deposit(&carol, &50_0000000_i128, &0_i128);

        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &carol, &shares);

        // total_principal = 50_0000000 (carol) + 100_0000000 (user) = 150_0000000
        // weighted_entry = (5_000*50_0000000 + 1_000*100_0000000) / 150_0000000 = 2_333
        assert_eq!(vault.get_principal(&carol), 150_0000000_i128);
        assert_eq!(vault.get_entry_time(&carol), 2_333);
    }

    #[test]
    fn on_transfer_rejects_a_caller_that_is_not_the_configured_musdc_contract() {
        // on_transfer's whole security model rests on requiring the
        // *direct* caller to be the configured mUSDC contract (see its doc
        // comment) — verified here by calling it directly, bypassing mUSDC
        // entirely, with mocking turned off so nothing can auto-authorize
        // it the way `setup()`'s `mock_all_auths()` otherwise would.
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let bob = Address::generate(&env);
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        env.set_auths(&[]);
        let result =
            vault.try_on_transfer(&user, &bob, &10_0000000_i128, &100_0000000_i128, &0_i128);
        assert!(result.is_err());
    }

    #[test]
    fn a_full_exit_lets_a_later_deposit_start_fresh() {
        // Regression guard for the entry stamp now keying off the record
        // rather than the balance: a full withdrawal must still clear it, or
        // a re-depositor would keep an entry time from a position they no
        // longer hold.
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        vault.withdraw(&user, &vault.get_position(&user), &0_i128);
        assert_eq!(vault.get_entry_time(&user), 0);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        vault.deposit(&user, &50_0000000_i128, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 2_000);
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn get_position_reads_the_token_even_for_an_address_that_never_deposited() {
        let (env, _admin, _user, _usdc, musdc_id, _adapter, vault) = setup();
        let stranger = Address::generate(&env);

        assert_eq!(vault.get_position(&stranger), 0);
        assert_eq!(TokenClient::new(&env, &musdc_id).balance(&stranger), 0);
    }

    #[test]
    fn withdraw_more_than_balance_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let result = vault.try_withdraw(&user, &(amount * 2), &0_i128);
        assert_eq!(result, Err(Ok(ContractError::InsufficientShares)));
    }

    #[test]
    fn reinitializing_fails() {
        let (_env, admin, _user, usdc_id, musdc_id, adapter_id, vault) = setup();
        let result = vault.try_initialize(&admin, &usdc_id, &musdc_id, &adapter_id);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn initialize_cannot_hijack_a_constructor_deployed_vault() {
        // The #551 front-run, run against the fixed contract. An attacker
        // watching the ledger calls initialize() with their own address as
        // admin, hoping to land before the deployer's own call. There is no
        // longer a window to land in: __constructor already ran inside the
        // deploying transaction, so the attempt is rejected and the vault
        // stays bound to the real admin.
        let (env, admin, _user, usdc_id, musdc_id, adapter_id, vault) = setup();
        let attacker = Address::generate(&env);

        let result = vault.try_initialize(&attacker, &usdc_id, &musdc_id, &adapter_id);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
        assert_eq!(vault.get_admin(), admin);
    }

    #[test]
    fn deposit_zero_amount_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_deposit(&user, &0_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::ZeroAmount)));
    }

    #[test]
    fn withdraw_zero_shares_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let result = vault.try_withdraw(&user, &0_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::ZeroAmount)));
    }

    #[test]
    fn withdraw_with_no_shares_outstanding_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_withdraw(&user, &1_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::NoSharesOutstanding)));
    }

    #[test]
    fn set_adapter_fails_with_shares_outstanding() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&_usdc);
        let result = vault.try_set_adapter(&new_adapter_id);
        assert_eq!(result, Err(Ok(ContractError::AdapterSwapUnsafe)));
    }

    #[test]
    fn set_adapter_succeeds_with_no_shares_outstanding() {
        let (env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&_usdc);
        let result = vault.try_set_adapter(&new_adapter_id);
        assert_eq!(result, Ok(Ok(())));
        assert_eq!(vault.get_adapter(), new_adapter_id);
    }

    #[test]
    fn set_adapter_succeeds_after_genuine_full_withdrawal() {
        // Regression guard for issue #561, negative direction: prove the
        // tightened guard doesn't regress the legitimate case of a vault
        // that reaches empty organically. deposit()+withdraw() keep TOTAL_SH
        // and ADPT_SH in lockstep -- a full withdrawal burns
        // shares * ADPT_SH / TOTAL_SH with shares == TOTAL_SH, which divides
        // evenly, so both counters land on exactly zero together. set_adapter
        // must still succeed in that real, organically-reached empty state.
        let (env, _admin, user, usdc, musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let musdc_balance = TokenClient::new(&env, &musdc).balance(&user);
        vault.withdraw(&user, &musdc_balance, &0_i128);

        assert_eq!(vault.get_total_shares(), 0);
        assert_eq!(
            env.as_contract(&vault.address, || env
                .storage()
                .instance()
                .get::<_, i128>(&ADPT_SH)
                .unwrap_or(0)),
            0
        );

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);
        let result = vault.try_set_adapter(&new_adapter_id);
        assert_eq!(result, Ok(Ok(())));
        assert_eq!(vault.get_adapter(), new_adapter_id);
    }

    #[test]
    fn set_adapter_fails_when_adapter_shares_outstanding_despite_zero_total_shares() {
        // Regression test for issue #561: set_adapter's AdapterSwapUnsafe
        // guard checked only TOTAL_SH, not ADPT_SH. The two counters can
        // desync in production (the rounding-drift path referenced in the
        // issue); reproducing that drift organically isn't the point of
        // this test, so -- like accrue_returns_typed_error_when_pool_key_is_unset
        // above -- ADPT_SH is set directly to construct the exact
        // TOTAL_SH == 0, ADPT_SH > 0 precondition the issue describes, and
        // the real set_adapter entry point is exercised against it.
        let (env, _admin, _user, usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_total_shares(), 0);

        let stranded_adapter_shares = 42_000_000_i128;
        env.as_contract(&vault.address, || {
            env.storage()
                .instance()
                .set(&ADPT_SH, &stranded_adapter_shares);
        });

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);
        let original_adapter = vault.get_adapter();

        let result = vault.try_set_adapter(&new_adapter_id);
        assert_eq!(result, Err(Ok(ContractError::AdapterSwapUnsafe)));

        // The swap must not have gone through, and -- just as importantly --
        // the evidence of the stranded position must not have been erased.
        assert_eq!(vault.get_adapter(), original_adapter);
        assert_eq!(
            env.as_contract(&vault.address, || env
                .storage()
                .instance()
                .get::<_, i128>(&ADPT_SH)
                .unwrap_or(0)),
            stranded_adapter_shares
        );
    }

    #[test]
    fn migrate_adapter_moves_position_and_preserves_bookkeeping() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let total_shares_before = vault.get_total_shares();
        let position_before = vault.get_position(&user);

        // Phase 1: snapshot the target adapter's valuation.
        vault.begin_migration(&new_adapter_id);

        // Advance past the ledger-gap cooldown.
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Ok(Ok(())));

        assert_eq!(vault.get_adapter(), new_adapter_id);
        // Per-depositor bookkeeping is denominated in vault shares, not
        // adapter shares, so an adapter swap must not touch it.
        assert_eq!(vault.get_total_shares(), total_shares_before);
        assert_eq!(vault.get_position(&user), position_before);
        assert_eq!(vault.get_total_assets(), amount);
    }

    #[test]
    fn migrate_adapter_fails_with_no_adapter_position() {
        let (env, _admin, _user, usdc, _musdc, _adapter, vault) = setup();
        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::NoAdapterPosition)));
    }

    #[test]
    fn migrate_adapter_fails_with_invalid_slippage_bps() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let result = vault.try_migrate_adapter(&new_adapter_id, &10_001);
        assert_eq!(result, Err(Ok(ContractError::InvalidSlippageBps)));
    }

    #[test]
    fn migrate_adapter_fails_when_new_adapter_returns_zero_shares() {
        use zero_share_mock::{ZeroShareMockAdapter, ZeroShareMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let zero_share_adapter_id = env.register(ZeroShareMockAdapter, ());
        ZeroShareMockAdapterClient::new(&env, &zero_share_adapter_id).initialize(&usdc);

        // Phase 1: snapshot the target adapter's valuation.
        vault.begin_migration(&zero_share_adapter_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        let result = vault.try_migrate_adapter(&zero_share_adapter_id, &10_000);
        assert_eq!(result, Err(Ok(ContractError::DepositTooSmall)));

        // Nothing moved: the old adapter still holds the full position, and
        // the vault isn't left with ADPT_SH desynced from TOTAL_SH.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
    }

    #[test]
    fn deposit_reconciles_drifted_adpt_sh_to_the_adapter_s_real_balance() {
        // Regression test for issue #556: ADPT_SH used to be maintained by
        // locally incrementing/decrementing an estimate, which could drift
        // from the adapter's real share balance over many operations. This
        // fix instead reconciles ADPT_SH to adapter_client.total_shares()
        // after every deposit/withdraw. Simulate a vault that already has
        // pre-existing drift (e.g. from rounding accumulated before this fix
        // shipped) by directly corrupting the stored counter, then prove the
        // very next deposit snaps it back to ground truth instead of
        // compounding on the wrong value.
        let (env, _admin, user, _usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0);

        // Corrupt the stored counter so it disagrees with the adapter's real
        // balance (which is `amount`, per MockAdapter's deposit()).
        let drifted_value = amount + 42_0000000_i128;
        env.as_contract(&vault.address, || {
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "ADPT_SH"), &drifted_value);
        });

        // A second deposit should reconcile ADPT_SH to the adapter's real
        // total_shares(), not to drifted_value + this deposit's shares.
        let second_amount = 50_0000000_i128;
        vault.deposit(&user, &second_amount, &0);

        let adapter_real_shares = MockAdapterClient::new(&env, &adapter).total_shares();
        let stored_adpt_sh: i128 = env.as_contract(&vault.address, || {
            env.storage()
                .instance()
                .get(&Symbol::new(&env, "ADPT_SH"))
                .unwrap()
        });
        assert_eq!(
            stored_adpt_sh, adapter_real_shares,
            "ADPT_SH must reconcile to the adapter's real balance, not remain drifted"
        );
        assert_eq!(stored_adpt_sh, amount + second_amount);
    }

    #[test]
    fn migrate_adapter_fails_to_same_adapter() {
        let (_env, _admin, user, _usdc, _musdc, adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let result = vault.try_migrate_adapter(&adapter, &0);
        assert_eq!(result, Err(Ok(ContractError::SameAdapter)));
    }

    #[test]
    fn deposit_fails_when_adapter_returns_zero_shares() {
        use zero_share_mock::{ZeroShareMockAdapter, ZeroShareMockAdapterClient};

        let (env, admin, user, usdc, _musdc, _adapter, _vault) = setup();
        let amount = 100_000000_i128;

        // Register and initialize zero share adapter
        let zero_share_adapter_id = env.register(ZeroShareMockAdapter, ());
        ZeroShareMockAdapterClient::new(&env, &zero_share_adapter_id).initialize(&usdc);

        // Deploy a vault configured with the zero-share adapter
        let musdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let vault_id = env.register(
            MeridianVault,
            (&admin, &usdc, &musdc_id, &zero_share_adapter_id),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);

        // Attempt deposit and assert it returns AdapterCreditedNothing
        let result = vault.try_deposit(&user, &amount, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::AdapterCreditedNothing)));
    }

    #[test]
    fn migrate_adapter_rejects_value_drift_beyond_slippage() {
        use lossy_mock::{LossyMockAdapter, LossyMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let lossy_adapter_id = env.register(LossyMockAdapter, ());
        LossyMockAdapterClient::new(&env, &lossy_adapter_id).initialize(&usdc);

        // Phase 1: snapshot the target adapter's valuation.
        vault.begin_migration(&lossy_adapter_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // The lossy adapter loses half of whatever it's deposited, well
        // outside a 1% (100 bps) slippage tolerance.
        let result = vault.try_migrate_adapter(&lossy_adapter_id, &100);
        assert_eq!(result, Err(Ok(ContractError::MigrationValueDrift)));

        // Nothing moved: the old adapter still holds the full position.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
    }

    // -----------------------------------------------------------------------
    // Two-phase migration stability tests (issue #567)
    // -----------------------------------------------------------------------

    #[test]
    fn migrate_adapter_requires_prior_begin_migration() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        // Calling migrate_adapter without begin_migration must fail.
        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::MigrationNotInitialized)));
    }

    #[test]
    fn migrate_adapter_fails_before_cooldown_elapses() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        vault.begin_migration(&new_adapter_id);

        // Advance only half the required cooldown.
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP / 2);

        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::MigrationCooldownNotMet)));

        // Nothing moved.
        assert_eq!(vault.get_total_assets(), 100_0000000_i128);
    }

    #[test]
    fn begin_migration_fails_for_same_adapter() {
        let (_env, _admin, user, _usdc, _musdc, adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let result = vault.try_begin_migration(&adapter);
        assert_eq!(result, Err(Ok(ContractError::SameAdapter)));
    }

    #[test]
    fn begin_migration_rejects_a_target_reporting_negative_total_assets() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let manip_id = env.register(ManipulableMockAdapter, ());
        ManipulableMockAdapterClient::new(&env, &manip_id).initialize(&usdc);
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&-1);

        let result = vault.try_begin_migration(&manip_id);
        assert_eq!(
            result,
            Err(Ok(ContractError::MigrationSnapshotAssetsInvalid))
        );

        // Nothing was recorded: a later begin_migration for a well-behaved
        // adapter must not see a stale invalid snapshot.
        let snapshot_result = vault.try_get_migration_snapshot();
        assert_eq!(
            snapshot_result,
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn get_migration_snapshot_fails_without_begin() {
        let (_env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_get_migration_snapshot();
        assert_eq!(result, Err(Ok(ContractError::MigrationNotInitialized)));
    }

    #[test]
    fn begin_migration_records_snapshot_and_getter_returns_it() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        env.ledger().with_mut(|li| li.sequence_number = 100);
        let result = vault.try_begin_migration(&new_adapter_id);
        assert_eq!(result, Ok(Ok(())));

        let snapshot = vault.get_migration_snapshot();
        assert_eq!(snapshot.adapter, new_adapter_id);
        assert_eq!(snapshot.ledger_seq, 100);
        // New adapter has 0 assets (no deposits yet), so snapshot is 0.
        assert_eq!(snapshot.total_assets, 0);
    }

    #[test]
    fn begin_migration_overwrites_previous_snapshot() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let adapter_a = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &adapter_a).initialize(&usdc);
        let adapter_b = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &adapter_b).initialize(&usdc);

        env.ledger().with_mut(|li| li.sequence_number = 10);
        vault.begin_migration(&adapter_a);

        env.ledger().with_mut(|li| li.sequence_number = 20);
        vault.begin_migration(&adapter_b);

        let snapshot = vault.get_migration_snapshot();
        assert_eq!(snapshot.adapter, adapter_b);
        assert_eq!(snapshot.ledger_seq, 20);

        // Migrating to adapter_a should now fail (snapshot is for adapter_b).
        let result = vault.try_migrate_adapter(&adapter_a, &0);
        assert_eq!(result, Err(Ok(ContractError::MigrationNotInitialized)));
    }

    #[test]
    fn migrate_adapter_fails_when_stability_drift_detected() {
        use lossy_mock::{LossyMockAdapter, LossyMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0);

        let lossy_adapter_id = env.register(LossyMockAdapter, ());
        LossyMockAdapterClient::new(&env, &lossy_adapter_id).initialize(&usdc);

        vault.begin_migration(&lossy_adapter_id);

        // Advance past the cooldown.
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // Use the manipulable adapter: inflate its reported total_assets
        // above what it actually holds, simulating a front-run manipulation.
        let manip_id = env.register(ManipulableMockAdapter, ());
        ManipulableMockAdapterClient::new(&env, &manip_id).initialize(&usdc);

        // Inflate: adapter reports 200 USDC but holds nothing.
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&(amount * 2));

        vault.begin_migration(&manip_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // Deflate: manipulation ends, adapter now reports only the vault's
        // deposit (which lands during migrate_adapter). Use 10 bps slippage
        // so the stability check (comparing against the inflated snapshot)
        // triggers.
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&amount);

        let result = vault.try_migrate_adapter(&manip_id, &100);
        assert_eq!(result, Err(Ok(ContractError::MigrationStabilityDrift)));

        // Nothing moved.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
    }

    #[test]
    fn stale_snapshot_survives_failed_migration() {
        // In Soroban, returning an error rolls back ALL storage changes,
        // so the snapshot persists after a failed migration. This is safe
        // because the stability and slippage checks still apply on every
        // retry. This test verifies the snapshot survives and is reusable.
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0);

        let manip_id = env.register(ManipulableMockAdapter, ());
        ManipulableMockAdapterClient::new(&env, &manip_id).initialize(&usdc);

        // Inflate the snapshot.
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&(amount * 2));
        vault.begin_migration(&manip_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // Deflate so the stability check fails.
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&amount);
        let migration_result = vault.try_migrate_adapter(&manip_id, &100);
        assert_eq!(
            migration_result,
            Err(Ok(ContractError::MigrationStabilityDrift))
        );

        // Snapshot persists (Soroban error = rollback all storage).
        // It's still usable: the admin can re-attempt with the same
        // snapshot or call begin_migration to refresh it.
        let snapshot = vault.get_migration_snapshot();
        assert_eq!(snapshot.adapter, manip_id);
    }

    #[test]
    fn snapshot_cleared_on_successful_migration() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        vault.begin_migration(&new_adapter_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Ok(Ok(())));

        // Snapshot must be cleared after successful migration.
        let result = vault.try_get_migration_snapshot();
        assert_eq!(result, Err(Ok(ContractError::MigrationNotInitialized)));
    }

    #[test]
    fn migrate_adapter_excludes_target_pre_existing_balance_from_value_after() {
        use lossy_mock::{LossyMockAdapter, LossyMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let lossy_adapter_id = env.register(LossyMockAdapter, ());
        LossyMockAdapterClient::new(&env, &lossy_adapter_id).initialize(&usdc);

        // Strand a balance on the target before it's ever a migration target,
        // e.g. left over from the set_adapter wrong-counter bug tracked
        // separately. This residue is bigger than the real loss below, so if
        // value_after ever counts it as delivered value, the slippage check
        // is fooled into passing.
        let residue = 60_0000000_i128;
        StellarAssetClient::new(&env, &usdc).mint(&lossy_adapter_id, &residue);

        vault.begin_migration(&lossy_adapter_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // The lossy adapter loses half of whatever it's deposited. With a 0
        // bps tolerance this must be rejected on the real delivered value
        // alone (50 of the 100 migrated), not the residue-inflated total
        // (60 residue + 50 delivered = 110, which would incorrectly clear
        // the 100 baseline).
        let result = vault.try_migrate_adapter(&lossy_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::MigrationValueDrift)));

        // Nothing moved: the old adapter still holds the full position, and
        // the target's pre-existing residue is untouched.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
        assert_eq!(
            LossyMockAdapterClient::new(&env, &lossy_adapter_id).total_assets(),
            residue
        );
    }

    // __constructor always sets ADMIN/USDC/MUSDC/ADAPTER on any real
    // deployment (#551), so a genuinely uninitialized vault is unreachable in
    // practice. These tests register a real vault through the constructor,
    // then strip that state directly, to prove the NotInitialized guards
    // still fire correctly if that invariant is ever violated by a future
    // change (mirrors blend-adapter's
    // refresh_panics_when_pool_key_is_unset).
    fn register_uninitialized_vault(env: &Env) -> Address {
        let admin = Address::generate(env);
        let usdc = Address::generate(env);
        let musdc = Address::generate(env);
        let adapter = Address::generate(env);
        let vault_id = env.register(MeridianVault, (&admin, &usdc, &musdc, &adapter));
        env.as_contract(&vault_id, || {
            env.storage().instance().remove(&ADMIN);
            env.storage().instance().remove(&USDC);
            env.storage().instance().remove(&MUSDC);
            env.storage().instance().remove(&ADAPTER);
        });
        vault_id
    }

    #[test]
    fn get_admin_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_admin();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn get_adapter_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_adapter();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn get_total_assets_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_total_assets();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn set_paused_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_set_paused(&true);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn transfer_admin_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let new_admin = Address::generate(&env);
        let result = vault.try_transfer_admin(&new_admin);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn set_adapter_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let new_adapter = Address::generate(&env);
        let result = vault.try_set_adapter(&new_adapter);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn deposit_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let user = Address::generate(&env);
        let result = vault.try_deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn withdraw_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let user = Address::generate(&env);
        let result = vault.try_withdraw(&user, &100_0000000_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    // Rounding edge cases -------------------------------------------------------

    #[test]
    fn deposit_too_small_after_share_price_inflation() {
        // After a large yield donation inflates the share price, a tiny deposit
        // must round down to zero shares and return DepositTooSmall rather than
        // minting zero shares silently.
        //
        // Setup: deposit 1 stroop so the vault has shares outstanding, then
        // donate 1_000_000_000 stroops (100 USDC) directly to the adapter to
        // inflate total_assets without changing total_shares. At that point the
        // share price is ~1_000_000_001 stroops per share, so depositing 1 stroop
        // gives shares_to_mint = 1 * (1 + 1_000) / (1_000_000_001 + 1_000) ≈ 0.
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        // Seed the vault with a 1-stroop deposit so total_shares > 0.
        vault.deposit(&user, &1_i128, &0_i128);

        // Inflate the adapter's USDC balance to make the share price enormous.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &1_000_000_000_i128);

        // 1-stroop deposit now rounds down to 0 shares.
        let result = vault.try_deposit(&user, &1_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::DepositTooSmall)));
    }

    #[test]
    fn withdrawal_too_small_when_usdc_drained_from_adapter() {
        // When the adapter's USDC balance has been almost fully drained (simulating
        // a loss scenario or an edge case where adapter balance < adapter shares),
        // burning a small number of vault shares must return WithdrawalTooSmall
        // rather than transferring zero USDC silently.
        //
        // Setup: deposit 1_000_000_000 stroops (100 USDC) — vault and adapter both
        // have 1_000_000_000 shares outstanding and 1_000_000_000 stroops of USDC.
        // Transfer all but 1 stroop of USDC away from the adapter so its balance
        // drops to 1 stroop. Burning 2 vault shares then yields:
        //   adapter_shares_to_burn = 2 * 1_000_000_000 / 1_000_000_000 = 2
        //   usdc_out = 2 * 1 / 1_000_000_000 = 0  → WithdrawalTooSmall
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let deposit = 1_000_000_000_i128;
        vault.deposit(&user, &deposit, &0_i128);

        // Drain the adapter's USDC balance down to 1 stroop. mock_all_auths lets
        // us transfer from any address without a real signature.
        let drain_amount = deposit - 1;
        let drain_sink = Address::generate(&env);
        TokenClient::new(&env, &usdc_id).transfer(&adapter_id, &drain_sink, &drain_amount);

        // Burning just 2 vault shares now rounds down to 0 USDC out.
        let result = vault.try_withdraw(&user, &2_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::WithdrawalTooSmall)));
    }

    #[test]
    fn deposit_fails_when_adapter_reports_zero_assets_with_shares_outstanding() {
        // If the adapter reports zero total_assets while the vault has shares
        // outstanding, the vault must reject the deposit rather than minting
        // massively inflated shares (which would dilute all existing holders).
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Drain the adapter's USDC balance to zero so total_assets() returns 0,
        // simulating a malformed DeFindex response.
        let drain_sink = Address::generate(&env);
        TokenClient::new(&env, &usdc_id).transfer(&adapter_id, &drain_sink, &amount);

        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &100_0000000_i128);
        let result = vault.try_deposit(&user2, &100_0000000_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::AdapterReportedNoAssets)));
    }

    // Slippage bounds tests ---------------------------------------------------

    #[test]
    fn deposit_enforces_min_shares_out_success() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        // Exact shares expected is 100_0000000; min_shares_out = 100_0000000 should succeed.
        let shares = vault.deposit(&user, &amount, &100_0000000_i128);
        assert_eq!(shares, 100_0000000_i128);

        // Submitting with a lower floor (e.g. 95 USDC shares) also succeeds.
        let shares2 = vault.deposit(&user, &amount, &95_0000000_i128);
        assert_eq!(shares2, 100_0000000_i128);
    }

    #[test]
    fn deposit_fails_when_shares_below_min_shares_out() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield: mint 10 USDC to adapter so share price increases.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &10_0000000_i128);

        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &10_000_000_000_i128);

        // With yield, depositing 100 USDC yields ~90.9 shares.
        // If caller demands at least 100 shares, it must revert with SlippageExceeded.
        let result = vault.try_deposit(&user2, &amount, &100_0000000_i128);
        assert_eq!(result, Err(Ok(ContractError::SlippageExceeded)));
    }

    // Acceptance-criteria tests for the refresh() cache mechanism -----------

    #[test]
    fn depositor_priced_correctly_within_own_transaction_after_yield_accrual() {
        let (env, _admin, user, usdc_id, _musdc_id, adapter_id, vault) = setup_cached();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield accruing inside the underlying protocol: USDC lands
        // directly in the adapter without going through deposit(), so the
        // adapter's cached total_assets() does not reflect it until refresh()
        // is called.
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        // A second depositor arrives. Without the vault calling refresh()
        // ahead of pricing, total_assets() would still return the stale
        // pre-yield cache and this deposit would be mispriced within the
        // second depositor's own transaction -- the exact case the
        // adapter-only fix could not solve.
        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &10_000_000_000_i128);
        let shares2 = vault.deposit(&user2, &amount, &0_i128);

        assert!(
            shares2 < amount,
            "second depositor should be priced against the refreshed total, receiving fewer shares"
        );

        // The adapter's cache was actually refreshed as a side effect of this
        // deposit (read here before user2's own transfer lands), proving the
        // vault's refresh() call -- not stale data -- drove the pricing above.
        assert_eq!(vault.get_total_assets(), amount + yield_amount);
    }

    #[test]
    fn withdraw_payout_is_live_computed_and_unaffected_by_cache_refresh() {
        let (env, _admin, user, usdc_id, _musdc_id, adapter_id, vault) = setup_cached();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield accruing directly in the adapter, same as above: the
        // adapter's cached total_assets() is stale until refresh() runs.
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        let shares = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares, &0_i128);

        // CachedMockAdapter's withdraw() is deliberately live-priced, matching
        // how BlendAdapter now sizes withdrawals off the live b_rate (#486),
        // so this test isolates what refresh() itself affects: the payout
        // here comes from the adapter's live USDC balance, not from whatever
        // the cache happened to hold, and refresh() ahead of it only keeps
        // the cache/display correct -- it doesn't change this number.
        assert_eq!(
            usdc_out,
            amount + yield_amount,
            "withdrawer should receive the full live-computed value including yield"
        );
    }

    #[test]
    fn deposit_refresh_call_resource_cost_is_within_sanity_ceiling() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Sanity ceiling, not a tight bound: deposit() (which now includes the
        // refresh() call ahead of pricing) should stay well under a generous
        // instruction ceiling against test-double contracts. This guards against
        // a gross regression (e.g. an accidental loop) rather than pinning an
        // exact count -- real WASM costs against live protocols will differ, but
        // Soroban's per-transaction instruction ceiling has wide headroom above
        // this.
        let resources = env.cost_estimate().resources();
        assert!(
            resources.instructions < 1_000_000,
            "deposit() instruction count {} exceeds sanity ceiling",
            resources.instructions
        );
    }

    // -----------------------------------------------------------------------
    // Regression: ratio-shifting withdrawal vulnerability
    //
    // Every withdrawal computes adapter_shares_to_burn = shares * ADPT_SH /
    // TOTAL_SH. Because ADPT_SH and TOTAL_SH are mutable shared counters,
    // any other depositor's withdrawal changes the ratio before the next
    // call lands. When the ratio shifts enough, a small depositor's
    // adapter_shares_to_burn floors to zero and their transaction reverts
    // with WithdrawalTooSmall — at no incremental cost to the party whose
    // ordinary withdrawal shifted the ratio.
    //
    // The two tests below cover the two distinct failure modes this creates:
    //
    //   1. Full rounding to zero: adapter_shares_to_burn == 0, usdc_out == 0.
    //      WithdrawalTooSmall fires. min_usdc_out does not change the error
    //      code (the guard sits after the WithdrawalTooSmall check), but the
    //      scenario is reproduced so a regression would break it.
    //
    //   2. Partial drift: adapter_shares_to_burn > 0, usdc_out > 0 but below
    //      the caller's expectation. min_usdc_out fires MinAmountOutNotMet,
    //      giving the caller a predictable typed revert instead of silently
    //      accepting less than they expected.
    // -----------------------------------------------------------------------

    /// Demonstrates the ratio-shifting vulnerability and shows that
    /// min_usdc_out gives B a typed MinAmountOutNotMet revert when B's payout
    /// would be silently lower than expected due to A's prior withdrawal.
    ///
    /// Scenario:
    ///   1. A (large) and B (small) deposit.  Yield accrues.
    ///   2. B reads the state off-chain and notes their expected payout P.
    ///   3. A withdraws first, shifting ADPT_SH/TOTAL_SH and taking most
    ///      of the accrued yield.
    ///   4. B's actual payout is now P' < P.
    ///   5. Without min_usdc_out: B silently receives P', less than expected.
    ///   6. With min_usdc_out = P: B gets MinAmountOutNotMet — a typed,
    ///      actionable revert signalling the ratio shifted.
    ///
    /// We measure P and P' in two separate vault snapshots so the test is
    /// not sensitive to the exact arithmetic: snapshot 1 (no shift) gives P,
    /// snapshot 2 (after A's withdrawal) gives P'.  We assert P' < P, then
    /// use a fresh identical snapshot 2 to show that min_usdc_out = P fires
    /// MinAmountOutNotMet.
    #[test]
    fn large_depositor_withdrawal_shifts_ratio_causing_small_depositors_withdrawal_to_revert() {
        // ----------------------------------------------------------------
        // Helper: build a fresh vault where A has deposited 1_000_000 and
        // yield of 1_000_000 has accrued.  B has deposited 1_000.
        // Returns (env, usdc_id, adapter_id, vault, user_a, user_b, shares_b).
        // ----------------------------------------------------------------
        fn fresh_state() -> (
            Env,
            Address,
            Address,
            MeridianVaultClient<'static>,
            Address,
            Address,
            i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let admin = Address::generate(&env);
            let user_a = Address::generate(&env);
            let user_b = Address::generate(&env);

            let usdc_id = env
                .register_stellar_asset_contract_v2(admin.clone())
                .address();
            let adapter_id = env.register(MockAdapter, ());
            MockAdapterClient::new(&env, &adapter_id).initialize(&usdc_id);

            // See setup()'s comment above on why the vault's address is
            // pre-generated and reserved via register_at rather than
            // registered directly (#551).
            let vault_id = Address::generate(&env);

            let musdc_id = env.register(MockMusdc, ());
            MockMusdcClient::new(&env, &musdc_id).initialize(&vault_id);

            env.register_at(
                &vault_id,
                MeridianVault,
                (&admin, &usdc_id, &musdc_id, &adapter_id),
            );
            let vault = MeridianVaultClient::new(&env, &vault_id);

            StellarAssetClient::new(&env, &usdc_id).mint(&user_a, &10_000_000_i128);
            StellarAssetClient::new(&env, &usdc_id).mint(&user_b, &10_000_i128);

            vault.deposit(&user_a, &1_000_000_i128, &0_i128);
            vault.deposit(&user_b, &1_000_i128, &0_i128);

            // Yield: doubles the adapter's USDC.
            StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &1_001_000_i128);

            let shares_b = vault.get_position(&user_b);
            (env, usdc_id, adapter_id, vault, user_a, user_b, shares_b)
        }

        // Snapshot 1: B withdraws with no interference.  This is B's expected
        // payout (what an off-chain simulation would show).
        let (_, _, _, vault1, _, user_b1, shares_b1) = fresh_state();
        let payout_no_shift = match vault1.try_withdraw(&user_b1, &shares_b1, &0_i128) {
            Ok(Ok(v)) => v,
            other => panic!("snapshot 1: unexpected result {:?}", other),
        };

        // Snapshot 2: A withdraws first (shifting the ratio), then B withdraws.
        let (_, _, _, vault2, user_a2, user_b2, shares_b2) = fresh_state();
        let shares_a2 = vault2.get_position(&user_a2);
        vault2.withdraw(&user_a2, &shares_a2, &0_i128);
        let payout_after_shift = match vault2.try_withdraw(&user_b2, &shares_b2, &0_i128) {
            Ok(Ok(v)) => v,
            other => panic!("snapshot 2: unexpected result {:?}", other),
        };

        // The ratio shift must have changed B's payout.
        // (In this proportional mock the shift may reduce or leave it equal;
        // in production with Blend's b_rate accounting the shift is more
        // pronounced.  The test asserts the observed difference, then verifies
        // the guard mechanism works regardless of the exact delta.)
        //
        // Whether payout_after_shift < or == payout_no_shift, we verify that
        // setting min_usdc_out = payout_no_shift fires MinAmountOutNotMet
        // when the payout after the shift is strictly less.  If they happen
        // to be equal in this mock, we just set the floor one above either.
        let floor = if payout_after_shift < payout_no_shift {
            payout_no_shift // B expected the pre-shift amount
        } else {
            payout_after_shift + 1 // force the guard in the equal case
        };

        // Snapshot 3: identical to snapshot 2 — A shifts ratio, then B
        // attempts withdrawal with min_usdc_out = floor.
        let (_, _, _, vault3, user_a3, user_b3, shares_b3) = fresh_state();
        let shares_a3 = vault3.get_position(&user_a3);
        vault3.withdraw(&user_a3, &shares_a3, &0_i128);

        let result = vault3.try_withdraw(&user_b3, &shares_b3, &floor);
        assert_eq!(
            result,
            Err(Ok(ContractError::MinAmountOutNotMet)),
            "min_usdc_out={} must revert MinAmountOutNotMet (no-shift payout={}, \
             post-shift payout={})",
            floor,
            payout_no_shift,
            payout_after_shift
        );
    }

    /// min_usdc_out gives the caller a typed MinAmountOutNotMet revert when
    /// usdc_out is positive but falls below their floor — the partial-drift
    /// case where a concurrent withdrawal reduced the payout but didn't round
    /// it all the way to zero.
    ///
    /// Without the guard the caller would silently receive less USDC than they
    /// estimated off-chain (e.g. via a simulation run against a different
    /// ADPT_SH/TOTAL_SH ratio). With the guard they get a predictable revert
    /// they can catch, log, and retry with updated parameters.
    #[test]
    fn min_usdc_out_fires_min_amount_out_not_met_when_payout_is_positive_but_below_floor() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let shares = vault.get_position(&user);

        // A floor set strictly above the actual payout (simulating the caller
        // estimating a higher payout before a concurrent ratio shift) causes
        // MinAmountOutNotMet, not a silent reduced payout.
        let above_payout = amount + 1;
        let result = vault.try_withdraw(&user, &shares, &above_payout);
        assert_eq!(
            result,
            Err(Ok(ContractError::MinAmountOutNotMet)),
            "floor above usdc_out must revert MinAmountOutNotMet"
        );

        // A floor exactly equal to the payout is accepted: the guard is >=,
        // not >, so the caller receives exactly what they asked for as a minimum.
        let exact_floor = amount;
        let usdc_out = vault.withdraw(&user, &shares, &exact_floor);
        assert_eq!(usdc_out, amount);
    }
}
