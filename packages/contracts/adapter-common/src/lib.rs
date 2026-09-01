#![no_std]

//! Shared scaffolding for Meridian yield adapters.
//!
//! This module provides common storage key definitions, initialization logic,
//! and error types used across all adapters (blend-adapter, defindex-adapter,
//! etc.). Protocol-specific yield logic remains in each adapter's own crate.

use soroban_sdk::{contracterror, panic_with_error, symbol_short, Address, Env, Error, Symbol};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/// Storage key for the vault address that owns this adapter.
pub const VAULT_KEY: Symbol = symbol_short!("VAULT");

/// Storage key for the USDC token address.
pub const USDC_KEY: Symbol = symbol_short!("USDC");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AdapterError {
    /// `initialize` was called on an adapter that already has a vault set.
    AlreadyInitialized = 1,
}

// ---------------------------------------------------------------------------
// Common initialization helper
// ---------------------------------------------------------------------------

/// Checks if the adapter has already been initialized (has VAULT_KEY set).
/// Returns `Err(AdapterError::AlreadyInitialized)` if already initialized,
/// `Ok(())` otherwise.
pub fn require_not_initialized(env: &Env) -> Result<(), AdapterError> {
    if env.storage().instance().has(&VAULT_KEY) {
        return Err(AdapterError::AlreadyInitialized);
    }
    Ok(())
}

/// Stores the vault and USDC addresses in instance storage.
/// This does NOT check for prior initialization - call `require_not_initialized`
/// first if needed.
pub fn store_vault_and_usdc(env: &Env, vault: &Address, usdc: &Address) {
    env.storage().instance().set(&VAULT_KEY, vault);
    env.storage().instance().set(&USDC_KEY, usdc);
}

// ---------------------------------------------------------------------------
// Common storage getters
// ---------------------------------------------------------------------------

/// Reads the vault address from storage and requires authorization from it.
/// Panics if the vault address is not set or authorization fails.
pub fn require_vault_auth(env: &Env) -> Address {
    let vault: Address = env.storage().instance().get(&VAULT_KEY).unwrap();
    vault.require_auth();
    vault
}

/// Reads the vault address from storage without requiring authorization.
/// Returns None if not set.
pub fn get_vault(env: &Env) -> Option<Address> {
    env.storage().instance().get(&VAULT_KEY)
}

/// Reads the USDC token address from storage.
/// Panics if not set.
pub fn get_usdc(env: &Env) -> Address {
    env.storage().instance().get(&USDC_KEY).unwrap()
}

// ---------------------------------------------------------------------------
// Shared NotInitialized helper
// ---------------------------------------------------------------------------

/// Lets each adapter's own `ContractError` supply its `NotInitialized`
/// variant to the shared `get_or_not_initialized` helper below, since each
/// adapter defines that enum itself (with a different discriminant) rather
/// than sharing one across crates.
pub trait NotInitializedError {
    fn not_initialized() -> Self;
}

/// Reads an instance-storage value, panicking with the caller's typed
/// NotInitialized error instead of an opaque unwrap trap if it's unset. In
/// practice this branch is unreachable on any contract deployed via
/// `__constructor`, since every storage key this is used for is set before
/// any other method is reachable; this exists as a defensive, correctly
/// typed fallback rather than a path expected to actually fire.
pub fn get_or_not_initialized<T, E>(env: &Env, value: Option<T>) -> T
where
    E: NotInitializedError + Into<Error>,
{
    value.unwrap_or_else(|| panic_with_error!(env, E::not_initialized()))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{contract, testutils::Address as _, Address, Env};

    // adapter-common has no #[contract] of its own — it's a shared library
    // crate, not a deployable contract. Instance storage is always scoped to
    // a specific contract, so exercising get_vault/store_vault_and_usdc/
    // require_not_initialized needs a real registered contract address to
    // run the calls under, via env.as_contract(). This dummy stands in for
    // any real adapter for that purpose only; none of its own methods are
    // exercised.
    #[contract]
    struct DummyAdapter;

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register(DummyAdapter, ());
        (env, contract_id)
    }

    /// `get_vault` returns `None` before `store_vault_and_usdc` is called.
    #[test]
    fn get_vault_returns_none_before_init() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            assert_eq!(get_vault(&env), None);
        });
    }

    /// `get_vault` returns `Some(vault)` after `store_vault_and_usdc` is called.
    #[test]
    fn get_vault_returns_some_after_store() {
        let (env, contract_id) = setup();
        let vault = Address::generate(&env);
        let usdc = Address::generate(&env);

        env.as_contract(&contract_id, || {
            store_vault_and_usdc(&env, &vault, &usdc);
            assert_eq!(get_vault(&env), Some(vault.clone()));
        });
    }

    /// `require_not_initialized` returns `Ok(())` on a fresh environment.
    #[test]
    fn require_not_initialized_ok_before_init() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            assert_eq!(require_not_initialized(&env), Ok(()));
        });
    }

    /// `require_not_initialized` returns `Err(AlreadyInitialized)` once
    /// `VAULT_KEY` has been written via `store_vault_and_usdc`.
    #[test]
    fn require_not_initialized_errs_after_store() {
        let (env, contract_id) = setup();
        let vault = Address::generate(&env);
        let usdc = Address::generate(&env);

        env.as_contract(&contract_id, || {
            store_vault_and_usdc(&env, &vault, &usdc);
            assert_eq!(
                require_not_initialized(&env),
                Err(AdapterError::AlreadyInitialized)
            );
        });
    }
}
