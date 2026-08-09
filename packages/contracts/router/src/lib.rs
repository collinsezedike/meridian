#![no_std]

use soroban_sdk::{contract, contractclient, contracterror, contractimpl, Address, Env};

/// Minimal vault interface used by the router. The generated `VaultClient`
/// serialises arguments to XDR and calls the target address; no vault code is
/// compiled into the router WASM.
#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn withdraw(env: Env, caller: Address, shares: i128) -> i128;
    fn deposit(env: Env, caller: Address, amount: i128) -> i128;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RouterError {
    /// Withdrawal returned fewer stroops than the caller-supplied `min_out`.
    SlippageExceeded = 1,
}

#[contract]
pub struct MeridianRouter;

#[contractimpl]
impl MeridianRouter {
    /// Atomically withdraw `shares` from `from_vault` and deposit the returned
    /// USDC into `to_vault`, all within one Soroban transaction.
    ///
    /// The depositor's signature covers both sub-invocations via Soroban's auth
    /// tree, so the call requires one `signTransaction` on the client side.
    /// If the withdrawal returns fewer stroops than `min_out`, returns
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

        let from = VaultClient::new(&env, &from_vault);
        let to = VaultClient::new(&env, &to_vault);

        let usdc_received = from.withdraw(&depositor, &shares);

        if usdc_received < min_out {
            return Err(RouterError::SlippageExceeded);
        }

        Ok(to.deposit(&depositor, &usdc_received))
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

        let router_id = env.register(MeridianRouter, ());
        let router = MeridianRouterClient::new(&env, &router_id);

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

        let router_id = env.register(MeridianRouter, ());
        let router = MeridianRouterClient::new(&env, &router_id);

        let amount = 100_0000000_i128;
        vault_a.deposit(&user, &amount);
        let shares = vault_a.get_position(&user);

        let result = router.try_rebalance(&user, &vault_a_id, &vault_b_id, &shares, &(amount * 2));
        assert_eq!(result, Err(Ok(RouterError::SlippageExceeded)));
    }
}
