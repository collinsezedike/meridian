use soroban_sdk::contracterror;

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
    /// `set_adapter` was called while the vault still has shares outstanding
    /// (`TOTAL_SH > 0`) or the old adapter still holds a position
    /// (`ADPT_SH > 0`). The two counters can desync (see `migrate_adapter`'s
    /// `NoAdapterPosition` doc), so both are checked: `TOTAL_SH` alone is not
    /// sufficient evidence that the old adapter is actually empty.
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
    /// `withdraw` was called with a `min_usdc_out` floor and the actual
    /// amount out fell below it. Distinct from `WithdrawalTooSmall` (which
    /// fires when `usdc_out` rounds to zero): this fires when `usdc_out > 0`
    /// but the caller's slippage tolerance was not met — i.e. the
    /// ADPT_SH/TOTAL_SH ratio shifted between when the caller estimated
    /// their proceeds and when their transaction landed.
    MinAmountOutNotMet = 15,
    /// `accept_admin` was called with no pending nominee recorded (no
    /// `transfer_admin` call has happened, or a previous nomination was
    /// already accepted).
    NoPendingAdmin = 16,
    /// The adapter reported zero or negative total assets while the vault
    /// still has shares outstanding, indicating a broken adapter or
    /// malformed protocol response. Depositing would dilute all existing
    /// holders.
    AdapterReportedNoAssets = 17,
    /// `deposit` output fell below caller-specified minimum bound (`min_shares_out`).
    SlippageExceeded = 18,
    /// `migrate_adapter` was called without a prior `begin_migration`
    /// call for the same target adapter.
    MigrationNotInitialized = 19,
    /// `migrate_adapter` was called before the minimum ledger-gap
    /// cooldown since `begin_migration` had elapsed.
    MigrationCooldownNotMet = 20,
    /// The new adapter's `total_assets()` drifted too far from the
    /// snapshot recorded by `begin_migration`, indicating possible
    /// manipulation or instability.
    MigrationStabilityDrift = 21,
    /// `begin_migration` was called against a target adapter reporting a
    /// negative `total_assets()`. A negative snapshot value defeats the
    /// stability check it feeds: the tolerance-scaled floor stays negative
    /// too, so any non-negative pre-deposit balance clears it regardless of
    /// how much the target is drained during the cooldown.
    MigrationSnapshotAssetsInvalid = 22,
    /// `deposit`'s adapter call returned zero or negative shares credited,
    /// indicating the underlying protocol rejected or dropped the deposit.
    /// Minting vault shares against it would dilute every existing holder
    /// with nothing backing the new shares.
    AdapterCreditedNothing = 23,
    /// A `checked_div` returned `None` because the divisor was zero.
    /// Distinct from `Overflow`: this points to a degenerate adapter state
    /// (e.g. zero `total_assets`) rather than a genuine arithmetic overflow.
    DivisionByZero = 24,
}
