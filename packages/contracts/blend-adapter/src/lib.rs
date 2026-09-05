#![no_std]

mod errors;
mod types;

pub use errors::ContractError;
pub use types::{
    b_tokens_to_usdc, BlendPoolClient, BlendPoolInterface, Positions, Request, Reserve,
    ReserveConfig, ReserveData, RATE_SCALAR, REQUEST_SUPPLY_COLLATERAL,
    REQUEST_WITHDRAW_COLLATERAL,
};

use adapter_common::{get_usdc, require_not_initialized, require_vault_auth, store_vault_and_usdc};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, panic_with_error, symbol_short,
    token::TokenClient,
    vec, Address, Env, IntoVal, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const POOL_KEY: Symbol = symbol_short!("POOL");
const TOTAL_KEY: Symbol = symbol_short!("TOTAL");

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MeridianBlendAdapter;

#[contractimpl]
impl MeridianBlendAdapter {
    /// Links the adapter to its vault, Blend pool, and USDC token.
    ///
    /// Runs inside the `CreateContract` host operation that deploys this
    /// adapter, in the same transaction, so the adapter is never observable
    /// on-ledger in an uninitialized state.
    ///
    /// This is what closes the front-running window in #505. `initialize()`
    /// below has no authorization check by design (there is no deployer
    /// identity in storage yet to check against), so for as long as deploy
    /// and initialize were two separate transactions, anyone watching the
    /// ledger could land `initialize()` first with their own address as
    /// `vault`, becoming the only party able to move funds through the
    /// adapter. Adding an auth check to `initialize()` would not have helped:
    /// it would only prove the racer controls the address they chose to pass
    /// in. Removing the intervening ledger is the fix.
    pub fn __constructor(env: Env, vault: Address, pool: Address, usdc: Address) {
        Self::init_state(&env, &vault, &pool, &usdc);
    }

    /// Retained so the ABI of adapters already deployed from earlier WASM is
    /// unchanged, and so an old adapter can still be initialized by hand.
    ///
    /// On any adapter deployed from this WASM it is unreachable:
    /// `__constructor` has already set `VAULT_KEY`, so every call returns
    /// `AlreadyInitialized`. That is the intended behaviour, not a leftover.
    /// An attacker calling this against a freshly deployed adapter is
    /// rejected instead of served.
    pub fn initialize(
        env: Env,
        vault: Address,
        pool: Address,
        usdc: Address,
    ) -> Result<(), ContractError> {
        require_not_initialized(&env)?;
        Self::init_state(&env, &vault, &pool, &usdc);
        Ok(())
    }

    /// The write half of initialization, shared by `__constructor` and
    /// `initialize` so the two can never set up different state. Not exported
    /// (no `pub`), so it is not callable from outside the contract.
    fn init_state(env: &Env, vault: &Address, pool: &Address, usdc: &Address) {
        store_vault_and_usdc(env, vault, usdc);
        env.storage().instance().set(&POOL_KEY, pool);
        env.storage().instance().set(&TOTAL_KEY, &0_i128);
    }

    /// Called by the vault after transferring `amount` USDC to this adapter.
    /// Supplies the USDC to the Blend lending pool as collateral and returns
    /// the real bTokens credited, measured from Blend's own ledger rather
    /// than assumed 1:1, so the vault's adapter-share accounting (`ADPT_SH`)
    /// tracks genuine, appreciating shares instead of raw principal (#486).
    pub fn deposit(env: Env, amount: i128) -> i128 {
        require_vault_auth(&env);

        let pool: Address = adapter_common::get_or_not_initialized::<_, ContractError>(
            &env,
            env.storage().instance().get(&POOL_KEY),
        );
        let usdc = get_usdc(&env);

        let adapter = env.current_contract_address();

        let client = BlendPoolClient::new(&env, &pool);
        let index = client.get_reserve(&usdc).config.index;
        // Map.get() safely returns Option, defaulting to 0 if the index doesn't exist.
        let b_tokens_before = client
            .get_positions(&adapter)
            .collateral
            .get(index)
            .unwrap_or(0);

        // Blend's pool pulls `amount` USDC from us (the spender) via its own
        // internal token.transfer call, not one we make directly. Self-auth via
        // direct invocation only covers calls WE make; it does not extend to
        // this nested transfer the pool triggers on our behalf several frames
        // down the stack, so we must pre-authorize it explicitly. This has to
        // be the LAST thing before `submit()`, with no other cross-contract
        // call in between: the tracker this creates is torn down the moment
        // any sub-invocation returns and its own call stack empties back out
        // (see `InvokerContractAuthorizationTracker`/`pop_frame`), so an
        // intervening call like `get_reserve()`/`get_positions()` above
        // silently expires it before `submit()` ever gets to consume it.
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

        client.submit(
            &adapter,
            &adapter,
            &adapter,
            &vec![
                &env,
                Request {
                    request_type: REQUEST_SUPPLY_COLLATERAL,
                    address: usdc,
                    amount,
                },
            ],
        );

        // Map.get() safely returns Option, defaulting to 0 if the index doesn't exist.
        let b_tokens_after = client
            .get_positions(&adapter)
            .collateral
            .get(index)
            .unwrap_or(0);
        let b_tokens_credited = b_tokens_after - b_tokens_before;

        // Instance storage read defaults to 0 if TOTAL_KEY hasn't been set, which is safe since
        // initialize() sets this key to 0. This unwrap_or pattern is the idiomatic way to handle
        // optional storage values in Soroban.
        let prev: i128 = env.storage().instance().get(&TOTAL_KEY).unwrap_or(0);
        env.storage().instance().set(&TOTAL_KEY, &(prev + amount));

        b_tokens_credited
    }

    /// Called by the vault to redeem `shares` bTokens from the Blend pool.
    /// Blend's own withdraw request is denominated in underlying USDC, not
    /// bTokens, so `shares` is converted using the current `b_rate` before
    /// submitting. Returns the USDC amount actually delivered to `recipient`,
    /// measured directly rather than assumed to equal the request (#489).
    pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
        require_vault_auth(&env);

        let pool: Address = adapter_common::get_or_not_initialized::<_, ContractError>(
            &env,
            env.storage().instance().get(&POOL_KEY),
        );
        let usdc = get_usdc(&env);

        let adapter = env.current_contract_address();
        let client = BlendPoolClient::new(&env, &pool);

        let reserve = client.get_reserve(&usdc);
        let request_amount = match b_tokens_to_usdc(shares, reserve.data.b_rate) {
            Ok(amount) => amount,
            Err(err) => panic_with_error!(&env, err),
        };

        let usdc_client = TokenClient::new(&env, &usdc);
        let before = usdc_client.balance(&recipient);

        client.submit(
            &adapter,
            &adapter,
            &recipient,
            &vec![
                &env,
                Request {
                    request_type: REQUEST_WITHDRAW_COLLATERAL,
                    address: usdc,
                    amount: request_amount,
                },
            ],
        );

        let after = usdc_client.balance(&recipient);
        let delivered = after - before;

        // Instance storage read defaults to 0 if TOTAL_KEY hasn't been set, which is safe since
        // initialize() sets this key to 0. This unwrap_or pattern is the idiomatic way to handle
        // optional storage values in Soroban.
        let prev: i128 = env.storage().instance().get(&TOTAL_KEY).unwrap_or(0);
        let remaining = if prev > delivered {
            prev - delivered
        } else {
            0
        };
        env.storage().instance().set(&TOTAL_KEY, &remaining);

        delivered
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
        let pool: Address = env
            .storage()
            .instance()
            .get(&POOL_KEY)
            .ok_or(ContractError::NotInitialized)?;
        let usdc = get_usdc(&env);
        let adapter = env.current_contract_address();

        let client = BlendPoolClient::new(&env, &pool);
        let reserve = client.get_reserve(&usdc);
        let positions = client.get_positions(&adapter);
        // Map.get() safely returns Option, defaulting to 0 if the index doesn't exist.
        let b_tokens = positions.collateral.get(reserve.config.index).unwrap_or(0);

        let current_value = b_tokens_to_usdc(b_tokens, reserve.data.b_rate)?;

        let prev: i128 = env.storage().instance().get(&TOTAL_KEY).unwrap_or(0);
        env.storage().instance().set(&TOTAL_KEY, &current_value);

        env.events()
            .publish((symbol_short!("accrue"),), (prev, current_value));

        Ok(())
    }

    /// Refreshes the cached total_assets to include yield accrued since the
    /// last call, satisfying the shared YieldAdapterInterface contract.
    /// Currently just calls accrue(), which remains a public,
    /// permissionless entry point in its own right.
    ///
    /// Panics on failure rather than returning a Result: the shared adapter
    /// interface's refresh() has no error return, so propagating accrue()'s
    /// Result would mean changing that interface's ABI across both adapters
    /// and the vault's calls into them. Panicking here instead of silently
    /// discarding the error preserves this function's pre-existing
    /// fail-loud behaviour (accrue()'s storage read used to be a bare
    /// unwrap(), which panicked directly) rather than downgrading a real
    /// failure into a silent no-op success.
    pub fn refresh(env: Env) {
        if let Err(err) = Self::accrue(env.clone()) {
            panic_with_error!(&env, err);
        }
    }

    /// Returns the cached USDC value of the adapter's Blend position. Reflects
    /// yield only as of the last `accrue()` call; call `accrue()` first for a
    /// value that includes interest accrued since then.
    pub fn total_assets(env: Env) -> i128 {
        // Instance storage read defaults to 0 if TOTAL_KEY hasn't been set, which is safe since
        // initialize() sets this key to 0. This unwrap_or pattern is the idiomatic way to handle
        // optional storage values in Soroban.
        env.storage().instance().get(&TOTAL_KEY).unwrap_or(0)
    }

    /// Returns the adapter's current bToken share balance, read directly from
    /// Blend's ledger rather than self-tracked.
    pub fn total_shares(env: Env) -> i128 {
        let pool: Address = adapter_common::get_or_not_initialized::<_, ContractError>(
            &env,
            env.storage().instance().get(&POOL_KEY),
        );
        let usdc = get_usdc(&env);
        let adapter = env.current_contract_address();

        let client = BlendPoolClient::new(&env, &pool);
        let reserve = client.get_reserve(&usdc);
        client
            .get_positions(&adapter)
            .collateral
            .get(reserve.config.index)
            .unwrap_or(0)
    }

    /// Returns the Blend pool this adapter supplies to.
    pub fn get_pool(env: Env) -> Address {
        adapter_common::get_or_not_initialized::<_, ContractError>(
            &env,
            env.storage().instance().get(&POOL_KEY),
        )
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
        testutils::{Address as _, Events, MockAuth, MockAuthInvoke},
        token::{StellarAssetClient, TokenClient},
        Address, Env, Map, Val,
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
            // Scalar and rate are always set in initialize(), so these are safe.
            let scalar: i128 = adapter_common::get_or_not_initialized::<_, ContractError>(
                &env,
                env.storage().instance().get(&M_SCALAR),
            );
            let rate: i128 = adapter_common::get_or_not_initialized::<_, ContractError>(
                &env,
                env.storage().instance().get(&M_RATE),
            );
            let mut collateral: i128 = env.storage().instance().get(&M_COLLAT).unwrap_or(0);

            for req in requests.iter() {
                if req.request_type == REQUEST_SUPPLY_COLLATERAL {
                    TokenClient::new(&env, &req.address).transfer(
                        &from,
                        &env.current_contract_address(),
                        &req.amount,
                    );
                    collateral += req.amount * scalar / rate;
                } else if req.request_type == REQUEST_WITHDRAW_COLLATERAL {
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
            // Scalar and rate are always set in initialize(), so these are safe.
            let internal_scalar: i128 = adapter_common::get_or_not_initialized::<_, ContractError>(
                &env,
                env.storage().instance().get(&M_SCALAR),
            );
            let scalar: i128 = env
                .storage()
                .instance()
                .get(&M_REP_SCL)
                .unwrap_or(internal_scalar);
            let rate: i128 = adapter_common::get_or_not_initialized::<_, ContractError>(
                &env,
                env.storage().instance().get(&M_RATE),
            );
            let index: u32 = adapter_common::get_or_not_initialized::<_, ContractError>(
                &env,
                env.storage().instance().get(&M_INDEX),
            );
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
            // Index is always set in initialize(), so this is safe.
            let index: u32 = adapter_common::get_or_not_initialized::<_, ContractError>(
                &env,
                env.storage().instance().get(&M_INDEX),
            );
            // Collateral safely defaults to 0 if not set yet, which is correct for a fresh adapter.
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

        // Registered with constructor arguments, which is how every real
        // deployment of this contract is now wired: there is no
        // deploy-then-initialize path left to exercise.
        let adapter_id = env.register(
            MeridianBlendAdapter,
            (vault.clone(), pool_id.clone(), usdc_id.clone()),
        );
        let adapter = MeridianBlendAdapterClient::new(&env, &adapter_id);

        // Fund the vault (the caller of deposit) with USDC, then act as the
        // vault transferring into the adapter, matching real vault behaviour.
        StellarAssetClient::new(&env, &usdc_id).mint(&vault, &10_000_000_000_i128);

        (env, vault, usdc_id, adapter, pool)
    }

    /// Same registration as `setup()`, without `mock_all_auths_allowing_non_root_auth()`.
    /// Shared by tests that need Blend's real, enforcing auth-tree check to
    /// run (either to prove a call is rejected without authorization, or to
    /// exercise the real call shape via `env.mock_auths`), since `setup()`'s
    /// blanket auth-mocking would mask both.
    fn setup_without_mock_auths() -> (
        Env,
        Address,
        Address,
        Address,
        MeridianBlendAdapterClient<'static>,
        MockBlendPoolClient<'static>,
    ) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let vault = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let pool_id = env.register(MockBlendPool, ());
        let pool = MockBlendPoolClient::new(&env, &pool_id);
        pool.initialize(&SCALAR, &RESERVE_INDEX);

        let adapter_id = env.register(
            MeridianBlendAdapter,
            (vault.clone(), pool_id.clone(), usdc_id.clone()),
        );
        let adapter = MeridianBlendAdapterClient::new(&env, &adapter_id);

        (env, admin, vault, usdc_id, adapter, pool)
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

    // `setup()` runs under `mock_all_auths_allowing_non_root_auth()`, which
    // switches the env into recording mode and accepts every `require_auth`
    // unconditionally — it never actually walks the authorization tree, so it
    // cannot catch a malformed `authorize_as_current_contract()` call. This
    // test instead mocks only the two real signer-facing invocations (the
    // vault funding the adapter, and the vault calling deposit) and lets
    // Blend's real, enforcing auth-tree check run against everything
    // `deposit()` triggers underneath, including the pool's own nested
    // `usdc.transfer()` call, exactly like a live network would. Guards
    // `authorize_as_current_contract()` above against silently regressing
    // into a shape that only passes under the mocked test harness.
    #[test]
    fn deposit_authorization_tree_matches_the_real_pool_call_shape() {
        let (env, admin, vault, usdc_id, adapter, _pool) = setup_without_mock_auths();

        let mint_amount = 10_000_000_000_i128;
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &usdc_id,
                fn_name: "mint",
                args: (vault.clone(), mint_amount).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        StellarAssetClient::new(&env, &usdc_id).mint(&vault, &mint_amount);

        let amount = 100_0000000_i128;

        env.mock_auths(&[MockAuth {
            address: &vault,
            invoke: &MockAuthInvoke {
                contract: &usdc_id,
                fn_name: "transfer",
                args: (vault.clone(), adapter.address.clone(), amount).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);

        env.mock_auths(&[MockAuth {
            address: &vault,
            invoke: &MockAuthInvoke {
                contract: &adapter.address,
                fn_name: "deposit",
                args: (amount,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let shares = adapter.deposit(&amount);

        assert_eq!(shares, amount);
    }

    #[test]
    fn total_shares_reads_the_pool_s_live_collateral_balance() {
        let (env, vault, usdc_id, adapter, _pool) = setup();
        assert_eq!(adapter.total_shares(), 0);

        let amount = 100_0000000_i128;
        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        let shares = adapter.deposit(&amount);

        // total_shares() reads Blend's own collateral map live, independent
        // of anything the vault separately tracks -- it must agree with the
        // bToken credit deposit() itself just returned.
        assert_eq!(adapter.total_shares(), shares);
    }

    #[test]
    fn deposit_credits_strictly_positive_b_tokens() {
        // Pin the semantics of REQUEST_SUPPLY_COLLATERAL: deposit() must
        // credit real, strictly-positive bTokens into Blend's collateral map.
        // A future Blend renumbering that maps the constant to a plain
        // "supply" request (or any behaviour that credits an empty bucket)
        // would surface here as a zero-credit deposit and fail this test,
        // rather than silently breaking the adapter's share accounting.
        let (env, vault, usdc_id, adapter, _pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        let shares = adapter.deposit(&amount);

        assert!(shares > 0, "deposit must credit strictly-positive bTokens");
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
    fn accrue_returns_typed_error_when_pool_key_is_unset() {
        // __constructor always sets POOL_KEY on any real deployment, so this
        // state is unreachable in practice; this test clears it directly
        // after construction to prove accrue() still fails with a typed
        // error rather than an opaque unwrap panic if that invariant is ever
        // violated by a future change.
        let (env, _vault, _usdc, adapter, _pool) = setup();
        env.as_contract(&adapter.address, || {
            env.storage().instance().remove(&POOL_KEY);
        });

        assert_eq!(adapter.try_accrue(), Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    #[should_panic]
    fn refresh_panics_when_pool_key_is_unset() {
        // refresh() has no error return (shared adapter interface), so it
        // must panic rather than silently no-op when accrue() fails.
        let (env, _vault, _usdc, adapter, _pool) = setup();
        env.as_contract(&adapter.address, || {
            env.storage().instance().remove(&POOL_KEY);
        });

        adapter.refresh();
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
    #[should_panic]
    fn refresh_panics_on_accrue_overflow() {
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 2_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        pool.set_rate(&i128::MAX);
        adapter.refresh();
    }

    #[test]
    #[should_panic]
    fn withdraw_panics_on_overflow() {
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 2_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        let shares = adapter.deposit(&amount);

        pool.set_rate(&i128::MAX);
        let recipient = Address::generate(&env);
        adapter.withdraw(&shares, &recipient);
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
        // Regression test for #486: withdraw() must size its Blend request
        // from real bTokens converted at the *current* b_rate, not from a
        // principal-tracking counter that never appreciates. Redeeming the
        // same bToken count credited at deposit, after the rate has moved,
        // must pay out the appreciated USDC value.
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        let b_tokens = adapter.deposit(&amount);
        assert_eq!(b_tokens, amount); // par rate at deposit time

        let new_rate = SCALAR + SCALAR / 10;
        pool.set_rate(&new_rate);
        assert_eq!(adapter.try_accrue(), Ok(Ok(())));
        assert_eq!(adapter.total_assets(), amount + amount / 10);

        // Fund the mock pool so it can pay out the appreciated amount.
        StellarAssetClient::new(&env, &usdc_id).mint(&pool.address, &(amount / 10));

        let recipient = Address::generate(&env);
        // The bToken balance itself doesn't change when the rate moves, only
        // its USDC value does — a real caller (the vault) sizes this from
        // ADPT_SH, which now tracks real bTokens, so it withdraws the same
        // count credited at deposit.
        let usdc_out = adapter.withdraw(&b_tokens, &recipient);

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
    fn constructor_sets_vault_pool_and_usdc() {
        let (env, vault, usdc_id, adapter, pool) = setup();

        // No initialize() call happened in setup(): every one of these was
        // written by __constructor during registration.
        assert_eq!(adapter.get_pool(), pool.address);
        assert_eq!(
            env.as_contract(&adapter.address, || adapter_common::get_vault(&env)),
            Some(vault)
        );
        assert_eq!(
            env.as_contract(&adapter.address, || adapter_common::get_usdc(&env)),
            usdc_id
        );
        assert_eq!(adapter.total_assets(), 0);
    }

    #[test]
    fn initialize_cannot_hijack_a_constructor_deployed_adapter() {
        // The #505 front-run, run against the fixed contract. An attacker
        // watching the ledger calls initialize() with their own address as
        // vault, hoping to land before the deployer's own call. There is no
        // longer a window to land in: __constructor already ran inside the
        // deploying transaction, so the attempt is rejected and the adapter
        // stays bound to the real vault.
        let (env, vault, usdc_id, adapter, pool) = setup();
        let attacker = Address::generate(&env);

        let result = adapter.try_initialize(&attacker, &pool.address, &usdc_id);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));

        assert_eq!(
            env.as_contract(&adapter.address, || adapter_common::get_vault(&env)),
            Some(vault)
        );
    }

    #[test]
    #[should_panic]
    fn deposit_requires_vault_auth() {
        // No mock_all_auths here: vault.require_auth() inside deposit() must
        // panic since nothing has authorized the stored vault address.
        let (_env, _admin, _vault, _usdc_id, adapter, _pool) = setup_without_mock_auths();

        adapter.deposit(&100_0000000_i128);
    }

    #[test]
    #[should_panic]
    fn withdraw_requires_vault_auth() {
        let (env, _admin, _vault, _usdc_id, adapter, _pool) = setup_without_mock_auths();

        let recipient = Address::generate(&env);
        adapter.withdraw(&100_0000000_i128, &recipient);
    }

    #[test]
    fn accrue_publishes_event_on_success() {
        let (env, vault, usdc_id, adapter, pool) = setup();
        let amount = 100_0000000_i128;

        TokenClient::new(&env, &usdc_id).transfer(&vault, &adapter.address, &amount);
        adapter.deposit(&amount);

        let new_rate = SCALAR + SCALAR / 10;
        pool.set_rate(&new_rate);

        assert_eq!(adapter.try_accrue(), Ok(Ok(())));

        let events = env.events().all();
        let accrue_event = events
            .into_iter()
            .find(|e| {
                if e.0 == adapter.address && e.1.len() == 1 {
                    if let Ok(topic) =
                        soroban_sdk::TryIntoVal::<_, soroban_sdk::Symbol>::try_into_val(
                            &e.1.get(0).unwrap(),
                            &env,
                        )
                    {
                        topic == symbol_short!("accrue")
                    } else {
                        false
                    }
                } else {
                    false
                }
            })
            .expect("accrue event not found");

        let expected_prev = amount;
        let expected_new = amount + amount / 10;
        let data: (i128, i128) =
            soroban_sdk::TryIntoVal::try_into_val(&accrue_event.2, &env).unwrap();
        assert_eq!(data, (expected_prev, expected_new));
    }
}
