use adapter_common::AdapterError;
use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// `initialize` was called on an adapter that already has a vault set.
    AlreadyInitialized = 1,
    /// An intermediate arithmetic operation would overflow `i128`.
    Overflow = 2,
    /// A state-mutating call was made before `initialize`.
    NotInitialized = 3,
    /// A `checked_div` returned `None` because the divisor was zero.
    /// Distinct from `Overflow`: this points to a degenerate adapter state
    /// (e.g. a zero `b_rate` from a broken Blend pool) rather than a genuine
    /// arithmetic overflow.
    DivisionByZero = 4,
}

impl From<AdapterError> for ContractError {
    fn from(err: AdapterError) -> Self {
        match err {
            AdapterError::AlreadyInitialized => ContractError::AlreadyInitialized,
        }
    }
}

impl adapter_common::NotInitializedError for ContractError {
    fn not_initialized() -> Self {
        ContractError::NotInitialized
    }
}
