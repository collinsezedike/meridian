#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, symbol_short, token::TokenClient, vec,
    Address, Env, Symbol, Val, Vec,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const VAULT_KEY: Symbol = symbol_short!("VAULT");
const DFX_VAULT: Symbol = symbol_short!("DFXVAULT");
const USDC_KEY: Symbol = symbol_short!("USDC");

// ---------------------------------------------------------------------------
// DeFindex vault interface
// ---------------------------------------------------------------------------

#[contractclient(name = "DefindexVaultClient")]
pub trait DefindexVaultInterface {
    // deposit returns (Vec<i128>, Vec<i128>, i128) — encoded as a 3-element
    // XDR vector. We use Val to avoid replicating the tuple shape.
    fn deposit(
        env: Env,
        amounts_desired: Vec<i128>,
        amounts_min: Vec<i128>,
        from: Address,
        invest: bool,
    ) -> Val;

    fn withdraw(
        env: Env,
        withdraw_shares: i128,
        min_amounts_out: Vec<i128>,
        from: Address,
    ) -> Vec<i128>;

    fn balance(env: Env, id: Address) -> i128;

    fn get_asset_amounts_per_shares(env: Env, desired_shares: i128) -> Vec<i128>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// `initialize` was called on an adapter that already has a vault set.
    AlreadyInitialized = 1,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MeridianDefindexAdapter;

#[contractimpl]
impl MeridianDefindexAdapter {
    /// Called once after deployment. Links the adapter to its vault, DeFindex
    /// vault contract, and USDC token.
    pub fn initialize(
        env: Env,
        vault: Address,
        defindex_vault: Address,
        usdc: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&VAULT_KEY) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&VAULT_KEY, &vault);
        env.storage().instance().set(&DFX_VAULT, &defindex_vault);
        env.storage().instance().set(&USDC_KEY, &usdc);
        Ok(())
    }

    /// Called by the vault after transferring `amount` USDC to this adapter.
    /// Deposits USDC into the DeFindex vault on behalf of the adapter and
    /// returns the dfToken shares received.
    pub fn deposit(env: Env, amount: i128) -> i128 {
        let vault: Address = env.storage().instance().get(&VAULT_KEY).unwrap();
        vault.require_auth();

        let dfx: Address = env.storage().instance().get(&DFX_VAULT).unwrap();
        let adapter = env.current_contract_address();

        let client = DefindexVaultClient::new(&env, &dfx);
        let shares_before = client.balance(&adapter);
        let _ = client.deposit(&vec![&env, amount], &vec![&env, 0_i128], &adapter, &true);
        let shares_after = client.balance(&adapter);

        shares_after - shares_before
    }

    /// Called by the vault to redeem `shares` dfTokens from the DeFindex vault.
    /// DeFindex sends USDC to this adapter; the adapter forwards it to
    /// `recipient`. Returns the USDC amount received.
    pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
        let vault: Address = env.storage().instance().get(&VAULT_KEY).unwrap();
        vault.require_auth();

        let dfx: Address = env.storage().instance().get(&DFX_VAULT).unwrap();
        let usdc: Address = env.storage().instance().get(&USDC_KEY).unwrap();
        let adapter = env.current_contract_address();

        let amounts =
            DefindexVaultClient::new(&env, &dfx).withdraw(&shares, &vec![&env, 0_i128], &adapter);

        let usdc_out: i128 = amounts.get(0).unwrap_or(0);
        if usdc_out > 0 {
            TokenClient::new(&env, &usdc).transfer(&adapter, &recipient, &usdc_out);
        }

        usdc_out
    }

    /// Live USDC value of the adapter's dfToken position, computed by the
    /// DeFindex vault's exchange rate. Updates automatically as yield accrues.
    pub fn total_assets(env: Env) -> i128 {
        let dfx: Address = env.storage().instance().get(&DFX_VAULT).unwrap();
        let adapter = env.current_contract_address();

        let client = DefindexVaultClient::new(&env, &dfx);
        let shares = client.balance(&adapter);
        if shares <= 0 {
            return 0;
        }

        let amounts = client.get_asset_amounts_per_shares(&shares);
        amounts.get(0).unwrap_or(0)
    }

    /// No-op: DeFindex's total_assets() already prices live on every call
    /// via the vault's exchange rate, so there is no cache to refresh.
    pub fn refresh(_env: Env) {}

    /// Returns the DeFindex vault this adapter deposits into.
    pub fn get_pool(env: Env) -> Address {
        env.storage().instance().get(&DFX_VAULT).unwrap()
    }

    /// Returns "defindex", identifying which protocol this adapter wraps.
    pub fn get_protocol(env: Env) -> Symbol {
        Symbol::new(&env, "defindex")
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
        testutils::Address as _,
        token::{StellarAssetClient, TokenClient},
        Address, Env,
    };

    // -----------------------------------------------------------------------
    // MockDefindexVault: a minimal DeFindex vault double. Tracks the adapter's
    // dfToken balance 1:1 with USDC deposited/withdrawn. `set_withdraw_amounts`
    // lets tests configure exactly what `withdraw` returns, so the
    // `amounts.get(0).unwrap_or(0)` edge case in the real adapter (a
    // differently-shaped or empty return vector) can be exercised directly.
    // -----------------------------------------------------------------------

    const MDV_USDC: Symbol = symbol_short!("MDV_USDC");
    const MDV_SH: Symbol = symbol_short!("MDV_SH");
    const MDV_WAMT: Symbol = symbol_short!("MDV_WAMT");

    #[contract]
    pub struct MockDefindexVault;

    #[contractimpl]
    impl MockDefindexVault {
        pub fn initialize(env: Env, usdc: Address) {
            env.storage().instance().set(&MDV_USDC, &usdc);
            env.storage().instance().set(&MDV_SH, &0_i128);
        }

        // Overrides what the next withdraw() call returns, to simulate a
        // differently-shaped (e.g. empty) response from DeFindex.
        pub fn set_withdraw_amounts(env: Env, amounts: Vec<i128>) {
            env.storage().instance().set(&MDV_WAMT, &amounts);
        }

        pub fn deposit(
            env: Env,
            amounts_desired: Vec<i128>,
            _amounts_min: Vec<i128>,
            from: Address,
            _invest: bool,
        ) -> Val {
            let usdc: Address = env.storage().instance().get(&MDV_USDC).unwrap();
            let amount = amounts_desired.get(0).unwrap_or(0);
            TokenClient::new(&env, &usdc).transfer(&from, &env.current_contract_address(), &amount);

            let prev: i128 = env.storage().instance().get(&MDV_SH).unwrap_or(0);
            env.storage().instance().set(&MDV_SH, &(prev + amount));
            Val::VOID.into()
        }

        pub fn withdraw(
            env: Env,
            withdraw_shares: i128,
            _min_amounts_out: Vec<i128>,
            from: Address,
        ) -> Vec<i128> {
            let prev: i128 = env.storage().instance().get(&MDV_SH).unwrap_or(0);
            env.storage()
                .instance()
                .set(&MDV_SH, &(prev - withdraw_shares));

            let amounts: Vec<i128> = env
                .storage()
                .instance()
                .get(&MDV_WAMT)
                .unwrap_or_else(|| vec![&env, withdraw_shares]);

            let usdc: Address = env.storage().instance().get(&MDV_USDC).unwrap();
            let payout = amounts.get(0).unwrap_or(0);
            if payout > 0 {
                TokenClient::new(&env, &usdc).transfer(
                    &env.current_contract_address(),
                    &from,
                    &payout,
                );
            }
            amounts
        }

        pub fn balance(env: Env, _id: Address) -> i128 {
            env.storage().instance().get(&MDV_SH).unwrap_or(0)
        }

        pub fn get_asset_amounts_per_shares(env: Env, desired_shares: i128) -> Vec<i128> {
            // 1:1 valuation, matching the deposit/withdraw rate used above.
            vec![&env, desired_shares]
        }
    }

    fn setup() -> (
        Env,
        Address,
        Address,
        MeridianDefindexAdapterClient<'static>,
        MockDefindexVaultClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let vault = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let dfx_id = env.register(MockDefindexVault, ());
        let dfx = MockDefindexVaultClient::new(&env, &dfx_id);
        dfx.initialize(&usdc_id);

        let adapter_id = env.register(MeridianDefindexAdapter, ());
        let adapter = MeridianDefindexAdapterClient::new(&env, &adapter_id);
        adapter.initialize(&vault, &dfx_id, &usdc_id);

        // Fund the vault (the caller of deposit) with USDC, then act as the
        // vault transferring into the adapter, matching real vault behaviour.
        StellarAssetClient::new(&env, &usdc_id).mint(&vault, &10_000_000_000_i128);

        (env, vault, usdc_id, adapter, dfx)
    }

    #[test]
    fn get_pool_returns_the_configured_defindex_vault() {
        let (_env, _vault, _usdc, adapter, dfx) = setup();
        assert_eq!(adapter.get_pool(), dfx.address);
    }

    #[test]
    fn get_protocol_returns_defindex() {
        let (env, _vault, _usdc, adapter, _dfx) = setup();
        assert_eq!(adapter.get_protocol(), Symbol::new(&env, "defindex"));
    }

    #[test]
    fn deposit_returns_the_dftoken_balance_diff() {
        let (env, vault, usdc_id, adapter, _dfx) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        let shares = adapter.deposit(&amount);

        assert_eq!(shares, amount);
        assert_eq!(adapter.total_assets(), amount);
    }

    #[test]
    fn withdraw_transfers_usdc_to_recipient() {
        let (env, vault, usdc_id, adapter, _dfx) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        let recipient = Address::generate(&env);
        let usdc_out = adapter.withdraw(&amount, &recipient);

        assert_eq!(usdc_out, amount);
        assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
    }

    #[test]
    fn withdraw_returns_zero_when_defindex_returns_no_amounts() {
        let (env, vault, usdc_id, adapter, dfx) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        // Simulate a shape mismatch: DeFindex returns an empty vector instead
        // of the expected [usdc_amount] — amounts.get(0).unwrap_or(0) must not
        // panic, and no USDC should move.
        dfx.set_withdraw_amounts(&Vec::new(&env));

        let recipient = Address::generate(&env);
        let usdc_out = adapter.withdraw(&amount, &recipient);

        assert_eq!(usdc_out, 0);
        assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), 0);
    }

    #[test]
    fn total_assets_returns_zero_with_no_shares() {
        let (_env, _vault, _usdc, adapter, _dfx) = setup();
        assert_eq!(adapter.total_assets(), 0);
    }

    #[test]
    fn total_assets_reflects_defindex_valuation() {
        let (env, vault, usdc_id, adapter, _dfx) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        // 1:1 mock valuation, so total_assets should exactly match what was
        // deposited even though it's routed through get_asset_amounts_per_shares
        // rather than a self-tracked total.
        assert_eq!(adapter.total_assets(), amount);
    }

    #[test]
    fn reinitializing_fails() {
        let (_env, vault, usdc_id, adapter, dfx) = setup();
        let result = adapter.try_initialize(&vault, &dfx.address, &usdc_id);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    #[should_panic]
    fn deposit_requires_vault_auth() {
        // No mock_all_auths here: vault.require_auth() inside deposit() must
        // panic since nothing has authorized the stored vault address.
        let env = Env::default();
        let admin = Address::generate(&env);
        let vault = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let dfx_id = env.register(MockDefindexVault, ());
        MockDefindexVaultClient::new(&env, &dfx_id).initialize(&usdc_id);
        let adapter_id = env.register(MeridianDefindexAdapter, ());
        let adapter = MeridianDefindexAdapterClient::new(&env, &adapter_id);
        adapter.initialize(&vault, &dfx_id, &usdc_id);

        adapter.deposit(&100_0000000_i128);
    }

    #[test]
    #[should_panic]
    fn withdraw_requires_vault_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let vault = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let dfx_id = env.register(MockDefindexVault, ());
        MockDefindexVaultClient::new(&env, &dfx_id).initialize(&usdc_id);
        let adapter_id = env.register(MeridianDefindexAdapter, ());
        let adapter = MeridianDefindexAdapterClient::new(&env, &adapter_id);
        adapter.initialize(&vault, &dfx_id, &usdc_id);

        let recipient = Address::generate(&env);
        adapter.withdraw(&100_0000000_i128, &recipient);
    }
}
