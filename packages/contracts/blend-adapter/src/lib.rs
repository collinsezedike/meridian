#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, vec,
    Address, Env, IntoVal, Map, Symbol, Val, Vec,
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

// Fixed-point base Blend's own contracts use for `Reserve.data.b_rate` (the
// bToken-to-underlying-asset exchange rate). This is a protocol-wide constant
// independent of any particular asset's decimals, and must NOT be confused
// with `Reserve.scalar` (which is `10^decimals` for the underlying asset,
// e.g. 1e7 for USDC) — the two are unrelated despite superficially similar
// magnitudes for some assets, and dividing by the wrong one silently
// corrupts `total_assets()` by orders of magnitude. Verified empirically
// against real testnet reserve data: `b_tokens * b_rate / RATE_SCALAR`
// reproduced the deposited amount plus a plausible small yield delta, while
// dividing by `reserve.scalar` produced a ~100,000x inflated value.
const RATE_SCALAR: i128 = 1_000_000_000_000;

// ---------------------------------------------------------------------------
// Blend pool interface types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
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

// Mirrors Blend's ReserveConfig (blend-contracts-v2/pool/src/storage.rs). Field
// order does not need to match Blend's declaration since #[contracttype]
// structs encode as a name-keyed map, but names and types must match exactly.
#[contracttype]
pub struct ReserveConfig {
    pub index: u32,
    pub decimals: u32,
    pub c_factor: u32,
    pub l_factor: u32,
    pub util: u32,
    pub max_util: u32,
    pub r_base: u32,
    pub r_one: u32,
    pub r_two: u32,
    pub r_three: u32,
    pub reactivity: u32,
    pub supply_cap: i128,
    pub enabled: bool,
}

// Mirrors Blend's ReserveData. `b_rate` is the bToken-to-underlying-asset
// exchange rate, scaled by the reserve's `scalar` (see `Reserve` below).
#[contracttype]
pub struct ReserveData {
    pub d_rate: i128,
    pub b_rate: i128,
    pub ir_mod: i128,
    pub b_supply: i128,
    pub d_supply: i128,
    pub backstop_credit: i128,
    pub last_time: u64,
}

// Mirrors Blend's Reserve (the return type of `get_reserve`).
#[contracttype]
pub struct Reserve {
    pub asset: Address,
    pub config: ReserveConfig,
    pub data: ReserveData,
    pub scalar: i128,
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
    fn get_reserve(env: Env, asset: Address) -> Reserve;
    fn get_positions(env: Env, address: Address) -> Positions;
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
    /// An intermediate arithmetic operation would overflow `i128`.
    Overflow = 2,
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
    pub fn initialize(
        env: Env,
        vault: Address,
        pool: Address,
        usdc: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&VAULT_KEY) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&VAULT_KEY, &vault);
        env.storage().instance().set(&POOL_KEY, &pool);
        env.storage().instance().set(&USDC_KEY, &usdc);
        env.storage().instance().set(&TOTAL_KEY, &0_i128);
        Ok(())
    }

    /// Called by the vault after transferring `amount` USDC to this adapter.
    /// Supplies the USDC to the Blend lending pool as collateral and returns
    /// `amount` as adapter shares (1:1; yield is reflected separately via
    /// `accrue()` rather than in the share-minting ratio).
    pub fn deposit(env: Env, amount: i128) -> i128 {
        let vault: Address = env.storage().instance().get(&VAULT_KEY).unwrap();
        vault.require_auth();

        let pool: Address = env.storage().instance().get(&POOL_KEY).unwrap();
        let usdc: Address = env.storage().instance().get(&USDC_KEY).unwrap();

        let adapter = env.current_contract_address();

        // Blend's pool pulls `amount` USDC from us (the spender) via its own
        // internal token.transfer call, not one we make directly. Self-auth via
        // direct invocation only covers calls WE make; it does not extend to
        // this nested transfer the pool triggers on our behalf several frames
        // down the stack, so we must pre-authorize it explicitly.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: usdc.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (adapter.clone(), pool.clone(), amount).into_val(&env),
                },
                sub_invocations: Vec::new(&env),
            }),
        ]);

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

    /// Refreshes the cached USDC value of the adapter's Blend position to
    /// include yield accrued since the last call. Permissionless: anyone can
    /// call it, and it should be called (by the vault or a keeper) before any
    /// `total_assets()` read that will inform a deposit or withdrawal price,
    /// since `total_assets()` itself only returns the cached value rather than
    /// querying Blend live on every call.
    ///
    /// Reads the adapter's current bToken balance from Blend's own ledger
    /// (`get_positions`) rather than self-tracking it, so there is no risk of
    /// drift between the stored total and Blend's actual accounting.
    pub fn accrue(env: Env) -> Result<(), ContractError> {
        let pool: Address = env.storage().instance().get(&POOL_KEY).unwrap();
        let usdc: Address = env.storage().instance().get(&USDC_KEY).unwrap();
        let adapter = env.current_contract_address();

        let client = BlendPoolClient::new(&env, &pool);
        let reserve = client.get_reserve(&usdc);
        let positions = client.get_positions(&adapter);
        let b_tokens = positions.collateral.get(reserve.config.index).unwrap_or(0);

        let current_value = b_tokens
            .checked_mul(reserve.data.b_rate)
            .ok_or(ContractError::Overflow)?
            .checked_div(RATE_SCALAR)
            .ok_or(ContractError::Overflow)?;

        env.storage().instance().set(&TOTAL_KEY, &current_value);
        Ok(())
    }

    /// Refreshes the cached total_assets to include yield accrued since the
    /// last call, satisfying the shared YieldAdapterInterface contract.
    /// Currently just calls accrue(), which remains a public,
    /// permissionless entry point in its own right.
    #[allow(unused_must_use)]
    pub fn refresh(env: Env) {
        Self::accrue(env);
    }

    /// Returns the cached USDC value of the adapter's Blend position. Reflects
    /// yield only as of the last `accrue()` call; call `accrue()` first for a
    /// value that includes interest accrued since then.
    pub fn total_assets(env: Env) -> i128 {
        env.storage().instance().get(&TOTAL_KEY).unwrap_or(0)
    }

    /// Returns the Blend pool this adapter supplies to.
    pub fn get_pool(env: Env) -> Address {
        env.storage().instance().get(&POOL_KEY).unwrap()
    }

    /// Returns "blend", identifying which protocol this adapter wraps.
    pub fn get_protocol(env: Env) -> Symbol {
        Symbol::new(&env, "blend")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::Address as _,
        token::{StellarAssetClient, TokenClient},
        Address, Env,
    };

    // -----------------------------------------------------------------------
    // MockBlendPool: a minimal Blend pool double. Tracks a single reserve's
    // exchange rate and the adapter's collateral (bToken) balance, so tests
    // can simulate yield by bumping the rate between deposit and accrue.
    // -----------------------------------------------------------------------

    const M_RATE: Symbol = symbol_short!("M_RATE");
    const M_SCALAR: Symbol = symbol_short!("M_SCALAR");
    const M_REP_SCL: Symbol = symbol_short!("M_REPSCL");
    const M_INDEX: Symbol = symbol_short!("M_INDEX");
    const M_COLLAT: Symbol = symbol_short!("M_COLLAT");

    #[contract]
    pub struct MockBlendPool;

    #[contractimpl]
    impl MockBlendPool {
        pub fn initialize(env: Env, scalar: i128, index: u32) {
            env.storage().instance().set(&M_RATE, &scalar);
            env.storage().instance().set(&M_SCALAR, &scalar);
            env.storage().instance().set(&M_INDEX, &index);
            env.storage().instance().set(&M_COLLAT, &0_i128);
        }

        pub fn set_rate(env: Env, rate: i128) {
            env.storage().instance().set(&M_RATE, &rate);
        }

        // Independently overrides the `scalar` field get_reserve() reports,
        // decoupled from the internal bToken-conversion ratio used by
        // submit(). Lets tests prove accrue() no longer depends on this field
        // at all — regressing to reading it would corrupt total_assets even
        // though this value has nothing to do with the rate's fixed-point
        // base, exactly the bug this mock exists to catch.
        pub fn set_reported_scalar(env: Env, scalar: i128) {
            env.storage().instance().set(&M_REP_SCL, &scalar);
        }

        pub fn submit(
            env: Env,
            from: Address,
            _spender: Address,
            to: Address,
            requests: Vec<Request>,
        ) -> Val {
            let scalar: i128 = env.storage().instance().get(&M_SCALAR).unwrap();
            let rate: i128 = env.storage().instance().get(&M_RATE).unwrap();
            let mut collateral: i128 = env.storage().instance().get(&M_COLLAT).unwrap_or(0);

            for req in requests.iter() {
                if req.request_type == REQUEST_SUPPLY {
                    TokenClient::new(&env, &req.address).transfer(
                        &from,
                        &env.current_contract_address(),
                        &req.amount,
                    );
                    collateral += req.amount * scalar / rate;
                } else if req.request_type == REQUEST_WITHDRAW {
                    collateral -= req.amount * scalar / rate;
                    TokenClient::new(&env, &req.address).transfer(
                        &env.current_contract_address(),
                        &to,
                        &req.amount,
                    );
                }
            }
            env.storage().instance().set(&M_COLLAT, &collateral);
            Val::VOID.into()
        }

        pub fn get_reserve(env: Env, asset: Address) -> Reserve {
            let internal_scalar: i128 = env.storage().instance().get(&M_SCALAR).unwrap();
            let scalar: i128 = env
                .storage()
                .instance()
                .get(&M_REP_SCL)
                .unwrap_or(internal_scalar);
            let rate: i128 = env.storage().instance().get(&M_RATE).unwrap();
            let index: u32 = env.storage().instance().get(&M_INDEX).unwrap();
            Reserve {
                asset,
                config: ReserveConfig {
                    index,
                    decimals: 7,
                    c_factor: 0,
                    l_factor: 0,
                    util: 0,
                    max_util: 0,
                    r_base: 0,
                    r_one: 0,
                    r_two: 0,
                    r_three: 0,
                    reactivity: 0,
                    supply_cap: 0,
                    enabled: true,
                },
                data: ReserveData {
                    d_rate: rate,
                    b_rate: rate,
                    ir_mod: 0,
                    b_supply: 0,
                    d_supply: 0,
                    backstop_credit: 0,
                    last_time: 0,
                },
                scalar,
            }
        }

        pub fn get_positions(env: Env, _address: Address) -> Positions {
            let index: u32 = env.storage().instance().get(&M_INDEX).unwrap();
            let collateral: i128 = env.storage().instance().get(&M_COLLAT).unwrap_or(0);
            let mut collateral_map = Map::new(&env);
            collateral_map.set(index, collateral);
            Positions {
                liabilities: Map::new(&env),
                collateral: collateral_map,
                supply: Map::new(&env),
            }
        }
    }

    // Matches RATE_SCALAR (Blend's real b_rate fixed-point base). Using the
    // same value here for both the mock's initial rate and its internal
    // bToken-conversion scalar keeps genesis at par (1 bToken = 1 unit) while
    // making set_rate() bumps interpretable directly against RATE_SCALAR, the
    // same way accrue() interprets a real reserve's b_rate.
    const SCALAR: i128 = RATE_SCALAR;
    const RESERVE_INDEX: u32 = 0;

    fn setup() -> (
        Env,
        Address,
        Address,
        MeridianBlendAdapterClient<'static>,
        MockBlendPoolClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let vault = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let pool_id = env.register(MockBlendPool, ());
        let pool = MockBlendPoolClient::new(&env, &pool_id);
        pool.initialize(&SCALAR, &RESERVE_INDEX);

        let adapter_id = env.register(MeridianBlendAdapter, ());
        let adapter = MeridianBlendAdapterClient::new(&env, &adapter_id);
        adapter.initialize(&vault, &pool_id, &usdc_id);

        // Fund the vault (the caller of deposit) with USDC, then act as the
        // vault transferring into the adapter, matching real vault behaviour.
        StellarAssetClient::new(&env, &usdc_id).mint(&vault, &10_000_000_000_i128);

        (env, vault, usdc_id, adapter, pool)
    }

    #[test]
    fn deposit_supplies_to_pool_and_tracks_total() {
        let (env, vault, usdc_id, adapter, _pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        let shares = adapter.deposit(&amount);

        assert_eq!(shares, amount);
        assert_eq!(adapter.total_assets(), amount);
    }

    #[test]
    fn get_pool_returns_the_configured_pool() {
        let (_env, _vault, _usdc, adapter, pool) = setup();
        assert_eq!(adapter.get_pool(), pool.address);
    }

    #[test]
    fn get_protocol_returns_blend() {
        let (env, _vault, _usdc, adapter, _pool) = setup();
        assert_eq!(adapter.get_protocol(), Symbol::new(&env, "blend"));
    }

    #[test]
    fn accrue_reflects_yield_from_a_rate_increase() {
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);
        assert_eq!(adapter.total_assets(), amount);

        // Simulate 10% yield: bTokens are now worth 10% more USDC each.
        let new_rate = SCALAR + SCALAR / 10;
        pool.set_rate(&new_rate);

        // total_assets() is a cache; it must not move until accrue() is called.
        assert_eq!(adapter.total_assets(), amount);

        assert_eq!(adapter.try_accrue(), Ok(Ok(())));
        assert_eq!(adapter.total_assets(), amount + amount / 10);
    }

    #[test]
    fn accrue_ignores_reserve_scalar_and_uses_the_real_rate_base() {
        // Regression test for the bug fixed alongside RATE_SCALAR: accrue()
        // must divide b_rate by Blend's fixed-point base (RATE_SCALAR),
        // never by whatever `reserve.scalar` happens to report. Real Blend
        // reserves report `scalar` as `10^asset_decimals` (e.g. 1e7 for
        // USDC) — a value that has nothing to do with the rate's own base
        // and is a completely different order of magnitude from it. Setting
        // the mock's reported scalar to something wildly different from
        // RATE_SCALAR here and asserting total_assets is unaffected proves
        // accrue() genuinely no longer reads that field for this
        // calculation.
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        // A USDC-like decimals scalar (1e7), wildly different from
        // RATE_SCALAR (1e12) — exactly the real-world mismatch that
        // corrupted total_assets on testnet before this fix.
        pool.set_reported_scalar(&10_000_000_i128);

        let new_rate = SCALAR + SCALAR / 10;
        pool.set_rate(&new_rate);
        assert_eq!(adapter.try_accrue(), Ok(Ok(())));

        assert_eq!(adapter.total_assets(), amount + amount / 10);
    }

    #[test]
    fn accrue_is_idempotent_at_a_stable_rate() {
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        assert_eq!(adapter.try_accrue(), Ok(Ok(())));
        let after_first = adapter.total_assets();
        assert_eq!(adapter.try_accrue(), Ok(Ok(())));
        let after_second = adapter.total_assets();

        assert_eq!(after_first, amount);
        assert_eq!(after_second, amount);
        let _ = pool;
    }

    #[test]
    fn accrue_returns_typed_error_on_overflow() {
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 2_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        pool.set_rate(&i128::MAX);
        let result = adapter.try_accrue();

        assert_eq!(result, Err(Ok(ContractError::Overflow)));
    }

    #[test]
    fn withdraw_returns_usdc_and_reduces_total() {
        let (env, vault, usdc_id, adapter, _pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        let recipient = Address::generate(&env);
        let usdc_out = adapter.withdraw(&amount, &recipient);

        assert_eq!(usdc_out, amount);
        assert_eq!(adapter.total_assets(), 0);
        assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
    }

    #[test]
    fn withdraw_after_accrue_pays_out_appreciated_value() {
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        let new_rate = SCALAR + SCALAR / 10;
        pool.set_rate(&new_rate);
        assert_eq!(adapter.try_accrue(), Ok(Ok(())));
        assert_eq!(adapter.total_assets(), amount + amount / 10);

        // Fund the mock pool so it can pay out the appreciated amount.
        StellarAssetClient::new(&env, &usdc_id).mint(&pool.address, &(amount / 10));

        let recipient = Address::generate(&env);
        let usdc_out = adapter.withdraw(&(amount + amount / 10), &recipient);

        assert_eq!(usdc_out, amount + amount / 10);
        assert_eq!(adapter.total_assets(), 0);
    }

    #[test]
    fn reinitializing_fails() {
        let (_env, vault, usdc_id, adapter, pool) = setup();
        let result = adapter.try_initialize(&vault, &pool.address, &usdc_id);
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
        let pool_id = env.register(MockBlendPool, ());
        MockBlendPoolClient::new(&env, &pool_id).initialize(&SCALAR, &RESERVE_INDEX);
        let adapter_id = env.register(MeridianBlendAdapter, ());
        let adapter = MeridianBlendAdapterClient::new(&env, &adapter_id);
        adapter.initialize(&vault, &pool_id, &usdc_id);

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
        let pool_id = env.register(MockBlendPool, ());
        MockBlendPoolClient::new(&env, &pool_id).initialize(&SCALAR, &RESERVE_INDEX);
        let adapter_id = env.register(MeridianBlendAdapter, ());
        let adapter = MeridianBlendAdapterClient::new(&env, &adapter_id);
        adapter.initialize(&vault, &pool_id, &usdc_id);

        let recipient = Address::generate(&env);
        adapter.withdraw(&100_0000000_i128, &recipient);
    }
}
