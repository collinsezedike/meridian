#![no_std]

use soroban_sdk::{
    contract, contractclient, contractimpl, symbol_short,
    token::TokenClient,
    vec, Address, Env, Symbol, Val, Vec,
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
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MeridianDefindexAdapter;

#[contractimpl]
impl MeridianDefindexAdapter {
    /// Called once after deployment. Links the adapter to its vault, DeFindex
    /// vault contract, and USDC token.
    pub fn initialize(env: Env, vault: Address, defindex_vault: Address, usdc: Address) {
        if env.storage().instance().has(&VAULT_KEY) {
            panic!("already initialized");
        }
        env.storage().instance().set(&VAULT_KEY, &vault);
        env.storage().instance().set(&DFX_VAULT, &defindex_vault);
        env.storage().instance().set(&USDC_KEY, &usdc);
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
        let _ = client.deposit(
            &vec![&env, amount],
            &vec![&env, 0_i128],
            &adapter,
            &true,
        );
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

        let amounts = DefindexVaultClient::new(&env, &dfx).withdraw(
            &shares,
            &vec![&env, 0_i128],
            &adapter,
        );

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
}
