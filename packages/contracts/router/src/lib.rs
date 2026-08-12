#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Env, Symbol,
};

/// Minimal vault interface used by the router. The generated `VaultClient`
/// serialises arguments to XDR and calls the target address; no vault code is
/// compiled into the router WASM.
#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn withdraw(env: Env, caller: Address, shares: i128) -> i128;
    fn deposit(env: Env, caller: Address, amount: i128) -> i128;
}

const ADMIN: Symbol = symbol_short!("ADMIN");

#[contracttype]
#[derive(Clone)]
enum DataKey {
    AllowedVault(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RouterError {
    /// Withdrawal returned fewer stroops than the caller-supplied `min_out`.
    SlippageExceeded = 1,
    /// `initialize` was called on a router that already has an admin set.
    AlreadyInitialized = 2,
    /// A state-mutating call was made before `initialize`.
    NotInitialized = 3,
    /// `rebalance` was called with a `from_vault`/`to_vault` that isn't on
    /// the admin-managed allowlist.
    VaultNotAllowed = 4,
    /// `rebalance` was called with the same address for `from_vault` and
    /// `to_vault`.
    SameVault = 5,
}

#[contract]
pub struct MeridianRouter;

#[contractimpl]
impl MeridianRouter {
    /// Called once at deployment. Sets the admin that controls the vault
    /// allowlist. Requires `admin.require_auth()`. Fails with
    /// `AlreadyInitialized` if called again.
    pub fn initialize(env: Env, admin: Address) -> Result<(), RouterError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(RouterError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&ADMIN, &admin);
        Ok(())
    }

    /// Admin-only. Adds `vault` to the set of addresses `rebalance` will
    /// accept as a `from_vault`/`to_vault`.
    pub fn add_vault(env: Env, vault: Address) -> Result<(), RouterError> {
        Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::AllowedVault(vault), &true);
        Ok(())
    }

    /// Admin-only. Removes `vault` from the allowlist.
    pub fn remove_vault(env: Env, vault: Address) -> Result<(), RouterError> {
        Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .remove(&DataKey::AllowedVault(vault));
        Ok(())
    }

    /// Returns whether `vault` is currently on the allowlist.
    pub fn is_allowed_vault(env: Env, vault: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::AllowedVault(vault))
            .unwrap_or(false)
    }

    /// Returns the current admin address.
    pub fn get_admin(env: Env) -> Result<Address, RouterError> {
        env.storage()
            .instance()
            .get(&ADMIN)
            .ok_or(RouterError::NotInitialized)
    }

    /// Admin-only key rotation. Lets a compromised or retired admin key be
    /// replaced without redeploying the router.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), RouterError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&ADMIN, &new_admin);
        Ok(())
    }

    /// Atomically withdraw `shares` from `from_vault` and deposit the returned
    /// USDC into `to_vault`, all within one Soroban transaction.
    ///
    /// The depositor's signature covers both sub-invocations via Soroban's auth
    /// tree, so the call requires one `signTransaction` on the client side.
    /// Fails with `SameVault` if `from_vault` equals `to_vault`, or
    /// `VaultNotAllowed` unless both `from_vault` and `to_vault` are on the
    /// admin-managed allowlist, so a depositor can't be routed into an
    /// attacker-controlled contract masquerading as a vault. If the
    /// withdrawal returns fewer stroops than `min_out`, returns
    /// `RouterError::SlippageExceeded` and the whole transaction reverts
    /// (including the withdrawal).
    ///
    /// Returns the number of shares minted by `to_vault`.
    pub fn rebalance(
        env: Env,
        depositor: Address,
        from_vault: Address,
        to_vault: Address,
        shares: i128,
        min_out: i128,
    ) -> Result<i128, RouterError> {
        depositor.require_auth();

        if from_vault == to_vault {
            return Err(RouterError::SameVault);
        }

        if !Self::is_allowed_vault(env.clone(), from_vault.clone())
            || !Self::is_allowed_vault(env.clone(), to_vault.clone())
        {
            return Err(RouterError::VaultNotAllowed);
        }

        let from = VaultClient::new(&env, &from_vault);
        let to = VaultClient::new(&env, &to_vault);

        let usdc_received = from.withdraw(&depositor, &shares);

        if usdc_received < min_out {
            return Err(RouterError::SlippageExceeded);
        }

        Ok(to.deposit(&depositor, &usdc_received))
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    fn require_admin(env: &Env) -> Result<(), RouterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(RouterError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meridian_vault::{MeridianVault, MeridianVaultClient};
    use soroban_sdk::{
        contract, contractimpl, symbol_short,
        testutils::Address as _,
        token::{StellarAssetClient, TokenClient},
        Address, Env, Symbol,
    };

    // Simple pass-through adapter for router tests (no yield, 1:1 USDC-to-shares).
    const TA_USDC: Symbol = symbol_short!("TA_USDC");
    const TA_SH: Symbol = symbol_short!("TA_SH");

    #[contract]
    struct TestAdapter;

    #[contractimpl]
    impl TestAdapter {
        pub fn initialize(env: Env, usdc: Address) {
            env.storage().instance().set(&TA_USDC, &usdc);
            env.storage().instance().set(&TA_SH, &0_i128);
        }

        pub fn deposit(env: Env, amount: i128) -> i128 {
            let prev: i128 = env.storage().instance().get(&TA_SH).unwrap_or(0);
            env.storage().instance().set(&TA_SH, &(prev + amount));
            amount
        }

        pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
            let usdc: Address = env.storage().instance().get(&TA_USDC).unwrap();
            TokenClient::new(&env, &usdc).transfer(
                &env.current_contract_address(),
                &recipient,
                &shares,
            );
            let prev: i128 = env.storage().instance().get(&TA_SH).unwrap_or(0);
            env.storage().instance().set(&TA_SH, &(prev - shares));
            shares
        }

        pub fn total_assets(env: Env) -> i128 {
            let usdc: Address = env.storage().instance().get(&TA_USDC).unwrap();
            TokenClient::new(&env, &usdc).balance(&env.current_contract_address())
        }

        pub fn refresh(_env: Env) {}
    }

    fn make_vault(
        env: &Env,
        admin: &Address,
        usdc_id: &Address,
    ) -> (Address, MeridianVaultClient<'static>) {
        let musdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let adapter_id = env.register(TestAdapter, ());
        TestAdapterClient::new(env, &adapter_id).initialize(usdc_id);

        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(env, &vault_id);
        vault.initialize(admin, usdc_id, &musdc_id, &adapter_id);
        StellarAssetClient::new(env, &musdc_id).set_admin(&vault_id);

        (vault_id, vault)
    }

    fn setup_router(env: &Env, admin: &Address) -> MeridianRouterClient<'static> {
        let router_id = env.register(MeridianRouter, ());
        let router = MeridianRouterClient::new(env, &router_id);
        router.initialize(admin);
        router
    }

    #[test]
    fn rebalance_moves_funds_between_vaults() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        let (vault_a_id, vault_a) = make_vault(&env, &admin, &usdc_id);
        let (vault_b_id, vault_b) = make_vault(&env, &admin, &usdc_id);

        let router = setup_router(&env, &admin);
        router.add_vault(&vault_a_id);
        router.add_vault(&vault_b_id);

        let amount = 100_0000000_i128;
        vault_a.deposit(&user, &amount);
        let shares = vault_a.get_position(&user);

        let new_shares = router.rebalance(&user, &vault_a_id, &vault_b_id, &shares, &1_i128);

        assert!(new_shares > 0);
        assert_eq!(vault_a.get_position(&user), 0);
        assert_eq!(vault_b.get_position(&user), new_shares);
    }

    #[test]
    fn rebalance_reverts_when_min_out_not_met() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        let (vault_a_id, vault_a) = make_vault(&env, &admin, &usdc_id);
        let (vault_b_id, _vault_b) = make_vault(&env, &admin, &usdc_id);

        let router = setup_router(&env, &admin);
        router.add_vault(&vault_a_id);
        router.add_vault(&vault_b_id);

        let amount = 100_0000000_i128;
        vault_a.deposit(&user, &amount);
        let shares = vault_a.get_position(&user);

        let result = router.try_rebalance(&user, &vault_a_id, &vault_b_id, &shares, &(amount * 2));
        assert_eq!(result, Err(Ok(RouterError::SlippageExceeded)));
    }

    #[test]
    fn rebalance_rejects_vault_not_on_allowlist() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        let (vault_a_id, vault_a) = make_vault(&env, &admin, &usdc_id);
        let (vault_b_id, _vault_b) = make_vault(&env, &admin, &usdc_id);

        let router = setup_router(&env, &admin);
        // Only vault_a is allowlisted; vault_b (e.g. an attacker-controlled
        // contract masquerading as a vault) is not.
        router.add_vault(&vault_a_id);

        let amount = 100_0000000_i128;
        vault_a.deposit(&user, &amount);
        let shares = vault_a.get_position(&user);

        let result = router.try_rebalance(&user, &vault_a_id, &vault_b_id, &shares, &1_i128);
        assert_eq!(result, Err(Ok(RouterError::VaultNotAllowed)));
        // Nothing moved: the position is still in vault_a.
        assert_eq!(vault_a.get_position(&user), shares);
    }

    #[test]
    fn rebalance_rejects_when_neither_vault_is_allowlisted() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        let (vault_a_id, vault_a) = make_vault(&env, &admin, &usdc_id);
        let (vault_b_id, _vault_b) = make_vault(&env, &admin, &usdc_id);

        let router = setup_router(&env, &admin);

        let amount = 100_0000000_i128;
        vault_a.deposit(&user, &amount);
        let shares = vault_a.get_position(&user);

        let result = router.try_rebalance(&user, &vault_a_id, &vault_b_id, &shares, &1_i128);
        assert_eq!(result, Err(Ok(RouterError::VaultNotAllowed)));
    }

    #[test]
    fn remove_vault_revokes_allowlist_membership() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let (vault_a_id, _vault_a) = make_vault(&env, &admin, &usdc_id);

        let router = setup_router(&env, &admin);
        router.add_vault(&vault_a_id);
        assert!(router.is_allowed_vault(&vault_a_id));

        router.remove_vault(&vault_a_id);
        assert!(!router.is_allowed_vault(&vault_a_id));
    }

    #[test]
    fn add_vault_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let (vault_a_id, _vault_a) = make_vault(&env, &admin, &usdc_id);

        let router_id = env.register(MeridianRouter, ());
        let router = MeridianRouterClient::new(&env, &router_id);

        let result = router.try_add_vault(&vault_a_id);
        assert_eq!(result, Err(Ok(RouterError::NotInitialized)));
    }

    #[test]
    fn reinitializing_router_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let router = setup_router(&env, &admin);

        let result = router.try_initialize(&admin);
        assert_eq!(result, Err(Ok(RouterError::AlreadyInitialized)));
    }

    #[test]
    fn set_admin_rotates_router_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let (vault_a_id, _vault_a) = make_vault(&env, &admin, &usdc_id);

        let router = setup_router(&env, &admin);
        router.set_admin(&new_admin);
        assert_eq!(router.get_admin(), new_admin);

        // The new admin can manage the allowlist.
        router.add_vault(&vault_a_id);
        assert!(router.is_allowed_vault(&vault_a_id));
    }

    #[test]
    fn set_admin_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let router_id = env.register(MeridianRouter, ());
        let router = MeridianRouterClient::new(&env, &router_id);

        let result = router.try_set_admin(&admin);
        assert_eq!(result, Err(Ok(RouterError::NotInitialized)));
    }

    #[test]
    fn rebalance_rejects_same_vault() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        let (vault_a_id, vault_a) = make_vault(&env, &admin, &usdc_id);

        let router = setup_router(&env, &admin);
        router.add_vault(&vault_a_id);

        let amount = 100_0000000_i128;
        vault_a.deposit(&user, &amount);
        let shares = vault_a.get_position(&user);

        let result = router.try_rebalance(&user, &vault_a_id, &vault_a_id, &shares, &1_i128);
        assert_eq!(result, Err(Ok(RouterError::SameVault)));
        assert_eq!(vault_a.get_position(&user), shares);
    }
}
