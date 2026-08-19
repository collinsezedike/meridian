#![no_std]

//! Shared scaffolding for Meridian yield adapters.
//!
//! This module provides common storage key definitions, initialization logic,
//! and error types used across all adapters (blend-adapter, defindex-adapter,
//! etc.). Protocol-specific yield logic remains in each adapter's own crate.

use soroban_sdk::{contracterror, symbol_short, Address, Env, Symbol};

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
