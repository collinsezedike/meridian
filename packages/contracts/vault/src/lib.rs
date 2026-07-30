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
    Balance(Address),
    Entry(Address),
    // Cost basis: net USDC an address has deposited. Used to derive yield earned
    // (current share value - principal). Reduced proportionally on withdrawal
    // and cleared on a full exit.
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

        // Track per-address share balance.
        let key = DataKey::Balance(caller.clone());
        let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &(prev + shares_to_mint));

        // Stamp the entry time on the user's first deposit; top-ups keep the
        // original time.
        if prev == 0 {
            let entry_key = DataKey::Entry(caller.clone());
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
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);

        if total_shares <= 0 {
            return Err(ContractError::NoSharesOutstanding);
        }

        // Verify caller holds enough shares.
        let key = DataKey::Balance(caller.clone());
        let caller_shares: i128 = env.storage().persistent().get(&key).unwrap_or(0);
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
        env.storage().persistent().set(&key, &remaining);

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
            env.storage()
                .persistent()
                .remove(&DataKey::Entry(caller.clone()));
            env.storage().persistent().remove(&principal_key);
        }

        Ok(usdc_out)
    }

    /// Returns the caller's mUSDC share balance.
    pub fn get_position(env: Env, address: Address) -> i128 {
        let key = DataKey::Balance(address);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Returns the ledger timestamp of the address's current deposit, or 0 if it
    /// holds no position. Reset whenever the position is fully withdrawn.
    pub fn get_entry_time(env: Env, address: Address) -> u64 {
        let key = DataKey::Entry(address);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Returns the address's cost basis: the net USDC deposited and not yet
    /// withdrawn. Yield earned is current share value minus this value.
    pub fn get_principal(env: Env, address: Address) -> i128 {
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl, symbol_short,
        testutils::{Address as _, Ledger as _},
        token::{StellarAssetClient, TokenClient},
        Address, Env, Symbol,
    };

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
            let usdc: Address = env.storage().instance().get(&MA_USDC).unwrap();
            let total_sh: i128 = env.storage().instance().get(&MA_SH).unwrap_or(0);
            let balance = TokenClient::new(&env, &usdc).balance(&env.current_contract_address());

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
            env.storage().instance().set(&MA_SH, &(total_sh - shares));
            usdc_out
        }

        pub fn total_assets(env: Env) -> i128 {
            let usdc: Address = env.storage().instance().get(&MA_USDC).unwrap();
            TokenClient::new(&env, &usdc).balance(&env.current_contract_address())
        }
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
}
