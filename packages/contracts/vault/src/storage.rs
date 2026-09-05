use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol};

// Storage keys
pub const ADMIN: Symbol = symbol_short!("ADMIN");
pub const PEND_ADM: Symbol = symbol_short!("PEND_ADM");
pub const USDC: Symbol = symbol_short!("USDC");
pub const MUSDC: Symbol = symbol_short!("MUSDC");
pub const ADAPTER: Symbol = symbol_short!("ADAPTER");
pub const TOTAL_SH: Symbol = symbol_short!("TOTAL_SH");
pub const ADPT_SH: Symbol = symbol_short!("ADPT_SH");
pub const PAUSED: Symbol = symbol_short!("PAUSED");
pub const MIG_SNAP: Symbol = symbol_short!("MIG_SNAP");
pub const MIG_ACTIVE: Symbol = symbol_short!("MIG_ACT");
// Sentinel stored in MIG_ACTIVE when a migration snapshot is live.
// 0 = inactive, 1 = active. Uses i128 because Soroban instance
// storage serialisation for bool may behave unexpectedly.

/// Minimum number of ledgers that must elapse between `begin_migration`
/// and `migrate_adapter` so the new adapter's valuation has time to
/// stabilise. At ~5 s per Stellar ledger close, 12 ledgers ≈ 1 minute.
pub const MIN_LEDGER_GAP: u32 = 12;

// Virtual shares/assets offset (OpenZeppelin ERC-4626 mitigation against the
// first-depositor inflation attack). Share price is computed against
// `total_assets + OFFSET` over `total_shares + OFFSET` instead of the raw
// values. The virtual liquidity belongs to no one, so an attacker who donates
// assets directly to the adapter recovers only ~1/OFFSET of the donation,
// making the skim strictly unprofitable. For honest depositors the offset is
// negligible (1_000 stroops = 0.0001 USDC).
pub const OFFSET: i128 = 1_000;

/// A snapshot of the target adapter's valuation, recorded by
/// `begin_migration` and verified by `migrate_adapter` after a minimum
/// ledger-gap cooldown.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MigrationSnapshot {
    pub adapter: Address,
    pub total_assets: i128,
    pub ledger_seq: u32,
}

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

pub fn clear_position_records(env: &Env, address: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Entry(address.clone()));
    env.storage()
        .persistent()
        .remove(&DataKey::Principal(address.clone()));
}
