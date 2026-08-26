#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short,
    token::{self, TokenClient},
    Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const ADMIN: Symbol = symbol_short!("ADMIN");
const USDC: Symbol = symbol_short!("USDC");
const MUSDC: Symbol = symbol_short!("MUSDC");
const ADAPTER: Symbol = symbol_short!("ADAPTER");
const TOTAL_SH: Symbol = symbol_short!("TOTAL_SH");
const ADPT_SH: Symbol = symbol_short!("ADPT_SH");
const PAUSED: Symbol = symbol_short!("PAUSED");

// Virtual shares/assets offset (OpenZeppelin ERC-4626 mitigation against the
// first-depositor inflation attack). Share price is computed against
// `total_assets + OFFSET` over `total_shares + OFFSET` instead of the raw
// values. The virtual liquidity belongs to no one, so an attacker who donates
// assets directly to the adapter recovers only ~1/OFFSET of the donation,
// making the skim strictly unprofitable. For honest depositors the offset is
// negligible (1_000 stroops = 0.0001 USDC).
const OFFSET: i128 = 1_000;

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
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // Deliberately no per-address share balance. mUSDC is a normal
    // transferable token, so an internal balance map is a second source of
    // truth that a plain `transfer()` silently invalidates: the recipient
    // could not withdraw (the map still said zero) and the sender could not
    // either (the map let the check pass, then `burn` failed on tokens they
    // no longer held), permanently stranding the position. Share ownership
    // is read from the mUSDC token itself, which is the only balance the
    // burn actually operates on.
    Entry(Address),
    // Cost basis: net USDC an address has deposited. Used to derive yield earned
    // (current share value - principal). Reduced proportionally on withdrawal
    // and cleared on a full exit.
    //
    // Unlike the share balance above, this is not derivable from any token:
    // it is history (what was paid, and when), not a current holding. It
    // therefore does not follow a transfer, see `get_principal`.
    Principal(Address),
}

/// Typed error codes returned by fallible contract entry points. Callers and
/// off-chain indexers can match on the variant instead of parsing panic
/// strings, and the numeric discriminant is stable across ABI changes.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// `initialize` was called on a contract that already has an admin set.
    AlreadyInitialized = 1,
    /// A state-mutating call was made before `initialize`.
    NotInitialized = 2,
    /// `deposit` was called while `set_paused(true)` is in effect.
    DepositsPaused = 3,
    /// `deposit` or `withdraw` was called with a non-positive amount/share count.
    ZeroAmount = 4,
    /// The deposited amount rounds down to zero shares at the current price.
    DepositTooSmall = 5,
    /// `withdraw` was called while the vault has no shares outstanding.
    NoSharesOutstanding = 6,
    /// The caller does not hold enough mUSDC shares to burn.
    InsufficientShares = 7,
    /// The shares burned round down to zero USDC at the current price.
    WithdrawalTooSmall = 8,
    /// An intermediate arithmetic operation would overflow `i128`.
    Overflow = 9,
    /// `set_adapter` was called while the vault still has shares outstanding.
    AdapterSwapUnsafe = 10,
    /// `migrate_adapter` was called with the vault's current adapter as the
    /// target.
    SameAdapter = 11,
    /// `migrate_adapter`'s post-migration value fell outside the caller's
    /// `max_slippage_bps` tolerance of the pre-migration value.
    MigrationValueDrift = 12,
    /// `migrate_adapter` was called while the vault's current adapter has no
    /// position to migrate. Distinct from `NoSharesOutstanding`: this checks
    /// `ADPT_SH` (adapter-side shares), not `TOTAL_SH` (vault mUSDC shares),
    /// and the two can desync.
    NoAdapterPosition = 13,
    /// `migrate_adapter` was called with `max_slippage_bps > 10_000`.
    InvalidSlippageBps = 14,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MeridianVault;

#[contractimpl]
impl MeridianVault {
    /// Called once at deployment. Sets the admin, USDC token address, mUSDC
    /// share token address, and the initial yield adapter address.
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
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&USDC, &usdc);
        env.storage().instance().set(&MUSDC, &musdc);
        env.storage().instance().set(&ADAPTER, &adapter);
        env.storage().instance().set(&TOTAL_SH, &0_i128);
        env.storage().instance().set(&ADPT_SH, &0_i128);
        Ok(())
    }

    /// Deposit `amount` USDC into the vault. USDC is forwarded to the yield
    /// adapter, which deploys it to the underlying protocol.
    ///
    /// Returns the number of mUSDC shares minted to the caller.
    pub fn deposit(env: Env, caller: Address, amount: i128) -> Result<i128, ContractError> {
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
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);

        // Refresh the adapter's cached total before pricing so this
        // depositor's own transaction is priced with up-to-date yield.
        AdapterClient::new(&env, &adapter_addr).refresh();

        // Share price is based on the adapter's total assets (includes yield).
        let total_assets = AdapterClient::new(&env, &adapter_addr).total_assets();

        // shares_to_mint = amount * (total_shares + OFFSET) / (total_assets + OFFSET)
        // The virtual offset makes the first-deposit price 1 share = 1 stroop while
        // neutralising the inflation attack on every subsequent deposit.
        let shares_to_mint = amount
            .checked_mul(total_shares + OFFSET)
            .ok_or(ContractError::Overflow)?
            .checked_div(total_assets + OFFSET)
            .ok_or(ContractError::Overflow)?;

        if shares_to_mint <= 0 {
            return Err(ContractError::DepositTooSmall);
        }

        // A caller who currently holds no shares but still has Entry/Principal
        // records is one who fully transferred a prior position away: the
        // vault has no hook on mUSDC's built-in `transfer`, so those records
        // were never cleared the way a full `withdraw()` clears them (see
        // `get_principal`). Left in place, this deposit would be treated as a
        // top-up onto a stale basis and entry time that belong to shares this
        // caller no longer holds. Clearing them first makes this the fresh
        // entry it actually is.
        if TokenClient::new(&env, &musdc).balance(&caller) == 0 {
            Self::clear_position_records(&env, &caller);
        }

        // Pull USDC from caller directly to the adapter.
        // The adapter address is known at this point, and the intermediate
        // vault-owned balance is never used.
        TokenClient::new(&env, &usdc).transfer(&caller, &adapter_addr, &amount);

        // Adapter deploys USDC to the underlying protocol and returns its own shares.
        let adapter_shares = AdapterClient::new(&env, &adapter_addr).deposit(&amount);

        // Mint mUSDC shares to caller.
        token::StellarAssetClient::new(&env, &musdc).mint(&caller, &shares_to_mint);

        // Update global share and adapter-share counters.
        env.storage()
            .instance()
            .set(&TOTAL_SH, &(total_shares + shares_to_mint));
        env.storage()
            .instance()
            .set(&ADPT_SH, &(total_adapter_shares + adapter_shares));

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
    pub fn withdraw(env: Env, caller: Address, shares: i128) -> Result<i128, ContractError> {
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
            .ok_or(ContractError::Overflow)?;

        // Adapter redeems protocol shares, delivers USDC to vault, returns amount.
        let usdc_out = AdapterClient::new(&env, &adapter_addr)
            .withdraw(&adapter_shares_to_burn, &env.current_contract_address());

        if usdc_out <= 0 {
            return Err(ContractError::WithdrawalTooSmall);
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
            .set(&ADPT_SH, &(total_adapter_shares - adapter_shares_to_burn));

        let remaining = caller_shares - shares;

        // Retire cost basis in proportion to shares burned.
        let principal_key = DataKey::Principal(caller.clone());
        let principal: i128 = env.storage().persistent().get(&principal_key).unwrap_or(0);
        let principal_out = principal
            .checked_mul(shares)
            .ok_or(ContractError::Overflow)?
            .checked_div(caller_shares)
            .ok_or(ContractError::Overflow)?;
        env.storage()
            .persistent()
            .set(&principal_key, &(principal - principal_out));

        // A full exit clears the entry time and cost basis so a later re-deposit
        // starts fresh.
        if remaining == 0 {
            Self::clear_position_records(&env, &caller);
        }

        Ok(usdc_out)
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
    /// when an address first deposits and is not carried by a transfer (see
    /// `get_principal` for why). An address holding no mUSDC reports 0 even
    /// if it deposited earlier and later transferred everything away, so a
    /// record left behind by a transfer-out is never reported as a live
    /// position.
    ///
    /// A zero-position holder with a leftover record here means the vault
    /// never got to observe the transfer that emptied it (only `withdraw()`
    /// clears eagerly; a plain `transfer()` gives the vault no hook at all).
    /// This call is the first chance to notice, so it clears the record
    /// before returning 0, rather than leaving it to resurface as a stale
    /// basis/entry time if this address's balance later becomes nonzero
    /// again through an unrelated deposit or transfer-in.
    pub fn get_entry_time(env: Env, address: Address) -> u64 {
        if Self::get_position(env.clone(), address.clone()) == 0 {
            Self::clear_position_records(&env, &address);
            return 0;
        }
        let key = DataKey::Entry(address);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Returns the address's cost basis: the net USDC it deposited and has not
    /// yet withdrawn. Yield earned is current share value minus this value.
    ///
    /// Cost basis is history, not a holding, so unlike the share balance it
    /// cannot be derived from the token and does not move with a transfer.
    /// mUSDC is a Stellar Asset Contract, whose `transfer` is the built-in
    /// implementation with no hook for the vault to observe, so there is no
    /// point at which the vault could split a sender's basis and hand part of
    /// it to a receiver. The consequences are bounded and only affect
    /// reporting, never the ability to withdraw:
    ///
    /// - An address that received mUSDC by transfer reports `0`, meaning "no
    ///   recorded basis", so its displayed yield is its full share value.
    /// - An address that transferred its position away reports `0` here
    ///   because it holds nothing, rather than a stale basis for shares it no
    ///   longer has.
    ///
    /// Making basis follow a transfer needs a share token the vault controls
    /// the code of; see `apps/docs/architecture/vault.md`.
    ///
    /// Like `get_entry_time`, a zero-position holder found with a leftover
    /// record here has one only because a plain `transfer()` emptied them
    /// with no hook for the vault to clear it eagerly. Clears it now so a
    /// later unrelated deposit or transfer-in can't inherit a stale basis.
    pub fn get_principal(env: Env, address: Address) -> i128 {
        if Self::get_position(env.clone(), address.clone()) == 0 {
            Self::clear_position_records(&env, &address);
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
        Ok(())
    }

    /// Returns whether deposits are currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED).unwrap_or(false)
    }

    /// Admin-only key rotation.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&ADMIN, &new_admin);
        Ok(())
    }

    /// Returns the current admin address.
    pub fn get_admin(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)
    }

    /// Replace the yield adapter. The vault must have no shares outstanding
    /// before calling this. Resets the adapter-share counter so the new adapter
    /// starts at zero.
    pub fn set_adapter(env: Env, new_adapter: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if Self::get_total_shares(env.clone()) > 0 {
            return Err(ContractError::AdapterSwapUnsafe);
        }
        env.storage().instance().set(&ADAPTER, &new_adapter);
        env.storage().instance().set(&ADPT_SH, &0_i128);
        Ok(())
    }

    /// Returns the current adapter address.
    pub fn get_adapter(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)
    }

    /// Admin-only. Moves the vault's entire position from the current adapter
    /// to `new_adapter` in one atomic transaction, without requiring
    /// depositors to withdraw first. Unlike `set_adapter`, this is safe to
    /// call with shares outstanding.
    ///
    /// Withdraws everything from the old adapter into the vault, deposits it
    /// into `new_adapter`, and requires the new adapter's reported
    /// `total_assets()` to be at least `(10_000 - max_slippage_bps) / 10_000`
    /// of the pre-migration value, or the whole call fails and nothing moves
    /// (Soroban transactions are atomic, so a failed invariant check leaves
    /// no partial state). `TOTAL_SH`, every holder's mUSDC balance, and every
    /// depositor's `Principal` and `Entry` are untouched: they're denominated
    /// in vault mUSDC shares, not adapter shares, so they remain valid across
    /// an adapter swap. Fails with `InvalidSlippageBps` if `max_slippage_bps`
    /// is not in `0..=10_000`; `10_000` itself is a valid, if extreme,
    /// choice, an admin explicitly accepting no protection against value
    /// loss, e.g. when recovering from an old adapter already known to be
    /// broken.
    ///
    /// This does not protect against a malicious or compromised admin key:
    /// the admin chooses `new_adapter`, and a fake adapter could report
    /// whatever `total_assets()` it likes to pass the slippage check and
    /// then keep the funds. The invariant guards against accidental value
    /// loss (slippage, a buggy new adapter), not against the admin key
    /// itself, that is a key-custody problem, not something this function
    /// can close.
    ///
    /// The invariant's real strength also depends on how honestly
    /// `new_adapter.total_assets()` reflects what it actually holds.
    /// `BlendAdapter::total_assets()` self-reports based on the amount
    /// `deposit()` was called with, not an independent on-chain measurement,
    /// so for a `BlendAdapter` target this check mainly catches loss on the
    /// withdrawal leg from the old adapter (measured independently before
    /// and after), not a `BlendAdapter` that silently fails to actually
    /// supply the funds to its pool while still returning success.
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

        let usdc = Self::usdc(&env)?;
        let old_adapter = AdapterClient::new(&env, &old_adapter_addr);

        // Read the old adapter's value independently, before extraction, so
        // this baseline can catch loss on the withdrawal leg itself (e.g. a
        // rate that moved, a rounding-lossy withdraw), not just loss on the
        // new-adapter leg.
        old_adapter.refresh();
        let value_before = old_adapter.total_assets();

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
        let new_adapter_client = AdapterClient::new(&env, &new_adapter);
        let new_shares = new_adapter_client.deposit(&withdrawn);
        if new_shares <= 0 {
            return Err(ContractError::DepositTooSmall);
        }
        let value_after = new_adapter_client.total_assets();

        let min_acceptable = value_before
            .checked_mul(10_000i128 - max_slippage_bps as i128)
            .ok_or(ContractError::Overflow)?
            .checked_div(10_000i128)
            .ok_or(ContractError::Overflow)?;
        if value_after < min_acceptable {
            return Err(ContractError::MigrationValueDrift);
        }

        env.storage().instance().set(&ADAPTER, &new_adapter);
        env.storage().instance().set(&ADPT_SH, &new_shares);
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

    /// Clears a holder's Entry/Principal records. The two are always
    /// written and read together, so every caller of this helper clears
    /// both rather than leaving one to go stale on its own (see
    /// `get_principal`, `get_entry_time`, `deposit`, and `withdraw`'s
    /// full-exit branch).
    fn clear_position_records(env: &Env, address: &Address) {
        env.storage()
            .persistent()
            .remove(&DataKey::Entry(address.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::Principal(address.clone()));
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl, panic_with_error, symbol_short,
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

            pub fn refresh(_env: Env) {
                // No-op: ZeroShareMockAdapter already prices total_assets() live.
            }
        }
    }

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
        let musdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let adapter_id = env.register(CachedMockAdapter, ());
        CachedMockAdapterClient::new(&env, &adapter_id).initialize(&usdc_id);

        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        vault.initialize(&admin, &usdc_id, &musdc_id, &adapter_id);

        StellarAssetClient::new(&env, &musdc_id).set_admin(&vault_id);

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

        // Deploy mock USDC and mUSDC tokens.
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let musdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &adapter_id).initialize(&usdc_id);

        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        vault.initialize(&admin, &usdc_id, &musdc_id, &adapter_id);

        StellarAssetClient::new(&env, &musdc_id).set_admin(&vault_id);

        // Fund the user with 1000 USDC (7 decimal places: 1000 * 10^7).
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        (env, admin, user, usdc_id, musdc_id, adapter_id, vault)
    }

    #[test]
    fn deposit_mints_shares() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        let shares = vault.deposit(&user, &amount);

        assert_eq!(shares, amount);
        assert_eq!(vault.get_position(&user), amount);
        assert_eq!(vault.get_total_shares(), amount);
    }

    #[test]
    fn withdraw_returns_usdc() {
        let (env, _admin, user, usdc_id, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);

        let shares = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares);

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
        vault.deposit(&user, &amount);
        assert_eq!(vault.get_principal(&user), amount);
    }

    #[test]
    fn topup_accumulates_principal() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128);
        vault.deposit(&user, &50_0000000_i128);
        assert_eq!(vault.get_principal(&user), 150_0000000_i128);
    }

    #[test]
    fn partial_withdraw_reduces_principal_proportionally() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);

        let half = vault.get_position(&user) / 2;
        vault.withdraw(&user, &half);
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn full_withdraw_clears_principal() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128);

        let shares = vault.get_position(&user);
        vault.withdraw(&user, &shares);
        assert_eq!(vault.get_principal(&user), 0);
    }

    #[test]
    fn share_value_exceeds_principal_after_yield() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);

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
        vault.deposit(&user, &amount);

        // Simulate yield: mint 10 USDC to the adapter.
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        // A second user deposits 100 USDC — should receive fewer shares because
        // the share price has risen.
        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &10_000_000_000_i128);
        let shares2 = vault.deposit(&user2, &amount);

        // 100 shares outstanding, vault has 110 USDC.
        // shares2 = 100 * 100 / 110 ≈ 90 shares.
        assert!(
            shares2 < amount,
            "second depositor should receive fewer shares"
        );

        // First user withdraws — should get more than 100 USDC back.
        let shares1 = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares1);
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
        let attacker_shares = vault.deposit(&attacker, &attacker_deposit);
        assert_eq!(attacker_shares, 1);

        // Attacker donates USDC directly to the adapter to inflate the share
        // price before the victim deposits (the classic inflation attack).
        let donation = 100_0000000_i128;
        usdc.transfer(&attacker, &adapter_id, &donation);

        let victim = Address::generate(&env);
        let victim_deposit = 100_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&victim, &victim_deposit);
        let victim_shares = vault.deposit(&victim, &victim_deposit);
        assert!(victim_shares > 0, "victim must receive shares");

        let attacker_out = vault.withdraw(&attacker, &attacker_shares);

        let attacker_in = attacker_deposit + donation;
        assert!(
            attacker_out * 100 < attacker_in,
            "inflation attack must not be profitable"
        );

        let victim_out = vault.withdraw(&victim, &victim_shares);
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

        vault.deposit(&user, &100_0000000_i128);
        assert_eq!(vault.get_entry_time(&user), 1_700_000_000);
    }

    #[test]
    fn topup_keeps_original_entry_time() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.ledger().set_timestamp(1_700_000_000);
        vault.deposit(&user, &100_0000000_i128);

        env.ledger().set_timestamp(1_700_500_000);
        vault.deposit(&user, &50_0000000_i128);
        assert_eq!(vault.get_entry_time(&user), 1_700_000_000);
    }

    #[test]
    fn full_withdraw_clears_entry_time() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.ledger().set_timestamp(1_700_000_000);
        vault.deposit(&user, &100_0000000_i128);

        let shares = vault.get_position(&user);
        vault.withdraw(&user, &shares);
        assert_eq!(vault.get_entry_time(&user), 0);
    }

    #[test]
    fn paused_blocks_deposit() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.set_paused(&true);
        let result = vault.try_deposit(&user, &100_0000000_i128);
        assert_eq!(result, Err(Ok(ContractError::DepositsPaused)));
    }

    #[test]
    fn withdraw_works_while_paused() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);

        vault.set_paused(&true);
        let shares = vault.get_position(&user);
        let out = vault.withdraw(&user, &shares);
        assert_eq!(out, amount);
    }

    #[test]
    fn unpause_re_enables_deposits() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.set_paused(&true);
        vault.set_paused(&false);
        assert!(!vault.is_paused());

        let shares = vault.deposit(&user, &100_0000000_i128);
        assert_eq!(shares, 100_0000000_i128);
    }

    #[test]
    fn set_admin_rotates_admin() {
        let (env, admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_admin(), admin);

        let new_admin = Address::generate(&env);
        vault.set_admin(&new_admin);
        assert_eq!(vault.get_admin(), new_admin);
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
        vault.deposit(&user, &amount);
        let shares = vault.get_position(&user);

        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        assert_eq!(vault.get_position(&user), 0);
        assert_eq!(vault.get_position(&bob), shares);

        let usdc_out = vault.withdraw(&bob, &shares);
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

        vault.deposit(&user, &100_0000000_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        let result = vault.try_withdraw(&user, &shares);
        assert_eq!(result, Err(Ok(ContractError::InsufficientShares)));
    }

    #[test]
    fn a_partial_transfer_leaves_both_holders_able_to_withdraw() {
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);
        let shares = vault.get_position(&user);
        let moved = shares / 2;
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &moved);

        assert_eq!(vault.get_position(&user), shares - moved);
        assert_eq!(vault.get_position(&bob), moved);

        let bob_out = vault.withdraw(&bob, &moved);
        let user_out = vault.withdraw(&user, &(shares - moved));

        assert_eq!(bob_out + user_out, amount);
        assert_eq!(TokenClient::new(&env, &usdc_id).balance(&bob), bob_out);
        assert_eq!(vault.get_total_shares(), 0);
    }

    #[test]
    fn withdrawing_after_a_partial_transfer_out_retires_basis_against_what_is_held() {
        // The proportional retirement divides by the caller's live balance,
        // so a holder who transferred half away still retires exactly the
        // basis for the shares they actually burn.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &(shares / 2));

        let held = vault.get_position(&user);
        vault.withdraw(&user, &(held / 2));

        // Half of what they held was burned, so half of the recorded basis
        // is retired; the basis for the transferred shares stays behind,
        // since nothing about the transfer told the vault it happened.
        assert_eq!(vault.get_principal(&user), amount / 2);
    }

    #[test]
    fn a_position_transferred_away_stops_being_reported() {
        // Entry and Principal records are left behind by a transfer the vault
        // cannot observe. Reporting them for an address that holds nothing
        // would show a phantom position, so both read as empty.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 12_345);
        vault.deposit(&user, &100_0000000_i128);
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
        vault.deposit(&user, &100_0000000_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        vault.deposit(&user, &50_0000000_i128);

        assert_eq!(vault.get_entry_time(&user), 2_000);
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn a_transfer_in_after_a_cleared_transfer_out_reports_no_stale_basis() {
        // A read while the holder was at zero (get_principal/get_entry_time,
        // as any position fetch would trigger) heals the stale record left
        // behind by the transfer-out. A later, unrelated transfer-in must
        // then find nothing left to inherit, not the basis/entry time of the
        // position this address held and gave up earlier.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        // Any read while the position is at zero heals the stale record.
        assert_eq!(vault.get_principal(&user), 0);
        assert_eq!(vault.get_entry_time(&user), 0);

        // bob transfers the same shares straight back to `user`, unrelated
        // to the position `user` held and gave up earlier.
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        TokenClient::new(&env, &musdc_id).transfer(&bob, &user, &shares);

        assert_eq!(vault.get_position(&user), shares);
        assert_eq!(vault.get_principal(&user), 0);
        assert_eq!(vault.get_entry_time(&user), 0);
    }

    #[test]
    fn a_transferred_in_position_reports_no_recorded_basis() {
        // Documented consequence of mUSDC being a Stellar Asset Contract:
        // its `transfer` is the built-in implementation, so there is no hook
        // the vault could use to move a sender's cost basis to the receiver.
        // The receiver can withdraw in full; only the yield figure derived
        // from basis is unknown, and reads as "nothing recorded".
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        vault.deposit(&user, &100_0000000_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        assert_eq!(vault.get_position(&bob), shares);
        assert_eq!(vault.get_principal(&bob), 0);
        assert_eq!(vault.get_entry_time(&bob), 0);
    }

    #[test]
    fn depositing_on_top_of_a_transferred_in_position_stamps_an_entry_time() {
        // The entry stamp keys off whether the address has ever deposited,
        // not off its share balance: an address holding transferred mUSDC has
        // never deposited, so its first deposit is a real entry.
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        vault.deposit(&user, &100_0000000_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        StellarAssetClient::new(&env, &usdc_id).mint(&bob, &10_0000000_i128);
        env.ledger().with_mut(|li| li.timestamp = 99_999);
        vault.deposit(&bob, &10_0000000_i128);

        assert_eq!(vault.get_entry_time(&bob), 99_999);
        assert_eq!(vault.get_principal(&bob), 10_0000000_i128);
    }

    #[test]
    fn a_full_exit_lets_a_later_deposit_start_fresh() {
        // Regression guard for the entry stamp now keying off the record
        // rather than the balance: a full withdrawal must still clear it, or
        // a re-depositor would keep an entry time from a position they no
        // longer hold.
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128);
        vault.withdraw(&user, &vault.get_position(&user));
        assert_eq!(vault.get_entry_time(&user), 0);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        vault.deposit(&user, &50_0000000_i128);
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
        vault.deposit(&user, &amount);
        let result = vault.try_withdraw(&user, &(amount * 2));
        assert_eq!(result, Err(Ok(ContractError::InsufficientShares)));
    }

    #[test]
    fn reinitializing_fails() {
        let (_env, admin, _user, usdc_id, musdc_id, adapter_id, vault) = setup();
        let result = vault.try_initialize(&admin, &usdc_id, &musdc_id, &adapter_id);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn deposit_zero_amount_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_deposit(&user, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::ZeroAmount)));
    }

    #[test]
    fn withdraw_zero_shares_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128);
        let result = vault.try_withdraw(&user, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::ZeroAmount)));
    }

    #[test]
    fn withdraw_with_no_shares_outstanding_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_withdraw(&user, &1_i128);
        assert_eq!(result, Err(Ok(ContractError::NoSharesOutstanding)));
    }

    #[test]
    fn set_adapter_fails_with_shares_outstanding() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);

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
    fn migrate_adapter_moves_position_and_preserves_bookkeeping() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let total_shares_before = vault.get_total_shares();
        let position_before = vault.get_position(&user);

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
        vault.deposit(&user, &100_0000000_i128);

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
        vault.deposit(&user, &amount);

        let zero_share_adapter_id = env.register(ZeroShareMockAdapter, ());
        ZeroShareMockAdapterClient::new(&env, &zero_share_adapter_id).initialize(&usdc);

        let result = vault.try_migrate_adapter(&zero_share_adapter_id, &10_000);
        assert_eq!(result, Err(Ok(ContractError::DepositTooSmall)));

        // Nothing moved: the old adapter still holds the full position, and
        // the vault isn't left with ADPT_SH desynced from TOTAL_SH.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
    }

    #[test]
    fn migrate_adapter_fails_to_same_adapter() {
        let (_env, _admin, user, _usdc, _musdc, adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128);

        let result = vault.try_migrate_adapter(&adapter, &0);
        assert_eq!(result, Err(Ok(ContractError::SameAdapter)));
    }

    #[test]
    fn migrate_adapter_rejects_value_drift_beyond_slippage() {
        use lossy_mock::{LossyMockAdapter, LossyMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);

        let lossy_adapter_id = env.register(LossyMockAdapter, ());
        LossyMockAdapterClient::new(&env, &lossy_adapter_id).initialize(&usdc);

        // The lossy adapter loses half of whatever it's deposited, well
        // outside a 1% (100 bps) slippage tolerance.
        let result = vault.try_migrate_adapter(&lossy_adapter_id, &100);
        assert_eq!(result, Err(Ok(ContractError::MigrationValueDrift)));

        // Nothing moved: the old adapter still holds the full position.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
    }

    #[test]
    fn get_admin_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_admin();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn get_adapter_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_adapter();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn get_total_assets_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_total_assets();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn set_paused_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_set_paused(&true);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn set_admin_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let new_admin = Address::generate(&env);
        let result = vault.try_set_admin(&new_admin);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn set_adapter_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let new_adapter = Address::generate(&env);
        let result = vault.try_set_adapter(&new_adapter);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn deposit_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let user = Address::generate(&env);
        let result = vault.try_deposit(&user, &100_0000000_i128);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn withdraw_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let user = Address::generate(&env);
        let result = vault.try_withdraw(&user, &100_0000000_i128);
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
        vault.deposit(&user, &1_i128);

        // Inflate the adapter's USDC balance to make the share price enormous.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &1_000_000_000_i128);

        // 1-stroop deposit now rounds down to 0 shares.
        let result = vault.try_deposit(&user, &1_i128);
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
        vault.deposit(&user, &deposit);

        // Drain the adapter's USDC balance down to 1 stroop. mock_all_auths lets
        // us transfer from any address without a real signature.
        let drain_amount = deposit - 1;
        let drain_sink = Address::generate(&env);
        TokenClient::new(&env, &usdc_id).transfer(&adapter_id, &drain_sink, &drain_amount);

        // Burning just 2 vault shares now rounds down to 0 USDC out.
        let result = vault.try_withdraw(&user, &2_i128);
        assert_eq!(result, Err(Ok(ContractError::WithdrawalTooSmall)));
    }

    // Acceptance-criteria tests for the refresh() cache mechanism -----------

    #[test]
    fn depositor_priced_correctly_within_own_transaction_after_yield_accrual() {
        let (env, _admin, user, usdc_id, _musdc_id, adapter_id, vault) = setup_cached();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount);

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
        let shares2 = vault.deposit(&user2, &amount);

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
        vault.deposit(&user, &amount);

        // Simulate yield accruing directly in the adapter, same as above: the
        // adapter's cached total_assets() is stale until refresh() runs.
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        let shares = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares);

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
        vault.deposit(&user, &amount);

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
}
