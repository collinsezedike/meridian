#![no_std]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short,
    vec, Address, Env, Map, Symbol, Val, Vec,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const VAULT_KEY: Symbol = symbol_short!("VAULT");
const POOL_KEY: Symbol = symbol_short!("POOL");
const USDC_KEY: Symbol = symbol_short!("USDC");
const TOTAL_KEY: Symbol = symbol_short!("TOTAL");

// Blend RequestType constants
const REQUEST_SUPPLY: u32 = 2;
const REQUEST_WITHDRAW: u32 = 3;

// ---------------------------------------------------------------------------
// Blend pool interface types
// ---------------------------------------------------------------------------

#[contracttype]
pub struct Request {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

// Blend pool returns a Positions struct; we define it to satisfy the return
// type but do not use the value. The XDR layout must match Blend's definition.
#[contracttype]
pub struct Positions {
    pub liabilities: Map<u32, i128>,
    pub collateral: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}

#[contractclient(name = "BlendPoolClient")]
pub trait BlendPoolInterface {
    fn submit(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Val;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MeridianBlendAdapter;

#[contractimpl]
impl MeridianBlendAdapter {
    /// Called once after deployment. Links the adapter to its vault, Blend pool,
    /// and USDC token.
    pub fn initialize(env: Env, vault: Address, pool: Address, usdc: Address) {
        if env.storage().instance().has(&VAULT_KEY) {
            panic!("already initialized");
        }
        env.storage().instance().set(&VAULT_KEY, &vault);
        env.storage().instance().set(&POOL_KEY, &pool);
        env.storage().instance().set(&USDC_KEY, &usdc);
        env.storage().instance().set(&TOTAL_KEY, &0_i128);
    }

    /// Called by the vault after transferring `amount` USDC to this adapter.
    /// Supplies the USDC to the Blend lending pool and returns `amount` as
    /// adapter shares (1:1 before yield accrual).
    pub fn deposit(env: Env, amount: i128) -> i128 {
        let vault: Address = env.storage().instance().get(&VAULT_KEY).unwrap();
        vault.require_auth();

        let pool: Address = env.storage().instance().get(&POOL_KEY).unwrap();
        let usdc: Address = env.storage().instance().get(&USDC_KEY).unwrap();

        let adapter = env.current_contract_address();
        BlendPoolClient::new(&env, &pool).submit(
            &adapter,
            &adapter,
            &adapter,
            &vec![
                &env,
                Request {
                    request_type: REQUEST_SUPPLY,
                    address: usdc,
                    amount,
                },
            ],
        );

        let prev: i128 = env.storage().instance().get(&TOTAL_KEY).unwrap_or(0);
        env.storage().instance().set(&TOTAL_KEY, &(prev + amount));

        amount
    }

    /// Called by the vault to redeem `shares` from the Blend pool. Blend
    /// delivers USDC directly to `recipient`. Returns the USDC amount received.
    ///
    /// Note: returned amount equals `shares` (1:1) until a follow-up `accrue()`
    /// function updates the stored Blend exchange rate to include yield.
    pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
        let vault: Address = env.storage().instance().get(&VAULT_KEY).unwrap();
        vault.require_auth();

        let pool: Address = env.storage().instance().get(&POOL_KEY).unwrap();
        let usdc: Address = env.storage().instance().get(&USDC_KEY).unwrap();

        let adapter = env.current_contract_address();
        BlendPoolClient::new(&env, &pool).submit(
            &adapter,
            &adapter,
            &recipient,
            &vec![
                &env,
                Request {
                    request_type: REQUEST_WITHDRAW,
                    address: usdc,
                    amount: shares,
                },
            ],
        );

        let prev: i128 = env.storage().instance().get(&TOTAL_KEY).unwrap_or(0);
        let remaining = if prev > shares { prev - shares } else { 0 };
        env.storage().instance().set(&TOTAL_KEY, &remaining);

        shares
    }

    /// Returns total USDC supplied to Blend. This value does not include
    /// accrued yield until a future `accrue()` function is implemented to
    /// update the stored Blend exchange rate.
    pub fn total_assets(env: Env) -> i128 {
        env.storage().instance().get(&TOTAL_KEY).unwrap_or(0)
    }
}
