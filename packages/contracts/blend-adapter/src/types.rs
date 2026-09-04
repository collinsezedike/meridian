use soroban_sdk::{contractclient, contracttype, Address, Env, Map, Val, Vec};

use crate::errors::ContractError;

// Blend RequestType constants, per
// blend-contracts-v2/pool/src/request_type.rs (submitted against the pool's
// `submit`). The "collateral" suffix is deliberate and load-bearing: this
// adapter deposits into the collateral map, NOT Blend's plain supply map, and
// deposit()/accrue() read bToken position from `Positions.collateral`. A
// future Blend renumbering (or a plain "supply" request) would silently credit
// an empty bucket and yield a zero-credit deposit; these are pinned here and
// guarded by the deposit test asserting a strictly-positive credit delta.
pub const REQUEST_SUPPLY_COLLATERAL: u32 = 2;
pub const REQUEST_WITHDRAW_COLLATERAL: u32 = 3;

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
pub const RATE_SCALAR: i128 = 1_000_000_000_000;

/// Converts a bToken amount to its underlying USDC value at the given
/// `b_rate`, guarding the intermediate multiply against i128 overflow.
/// Shared by accrue() and withdraw() so the two never drift apart.
pub fn b_tokens_to_usdc(b_tokens: i128, b_rate: i128) -> Result<i128, ContractError> {
    b_tokens
        .checked_mul(b_rate)
        .ok_or(ContractError::Overflow)?
        .checked_div(RATE_SCALAR)
        .ok_or(ContractError::Overflow)
}

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
