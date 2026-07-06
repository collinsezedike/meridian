#![no_std]

use soroban_sdk::{contract, contractclient, contractimpl, contracttype, Address, Env};

/// Mirrors `meridian_vault::Protocol`. Both types carry `#[contracttype]` with
/// identical variant names, so their XDR encoding is the same and values pass
/// safely across the cross-contract boundary.
#[contracttype]
#[derive(Clone)]
pub enum Protocol {
    Blend,
    DeFindex,
}

/// Minimal vault interface used by the router. The generated `VaultClient`
/// serialises arguments to XDR and calls the target address; no vault code is
/// compiled into the router WASM.
#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn withdraw(env: Env, caller: Address, shares: i128) -> i128;
    fn deposit(env: Env, caller: Address, amount: i128, route_to: Protocol) -> i128;
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
    /// If the withdrawal returns fewer stroops than `min_out`, the function
    /// panics and the whole transaction reverts (including the withdrawal).
    ///
    /// Returns the number of shares minted by `to_vault`.
    pub fn rebalance(
        env: Env,
        depositor: Address,
        from_vault: Address,
        to_vault: Address,
        shares: i128,
        min_out: i128,
        route_to: Protocol,
    ) -> i128 {
        depositor.require_auth();

        let from = VaultClient::new(&env, &from_vault);
        let to = VaultClient::new(&env, &to_vault);

        let usdc_received = from.withdraw(&depositor, &shares);

        if usdc_received < min_out {
            panic!("slippage: received less than minimum");
        }

        to.deposit(&depositor, &usdc_received, &route_to)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meridian_vault::{MeridianVault, MeridianVaultClient, Protocol as VaultProtocol};
    use soroban_sdk::{
        testutils::Address as _,
        token::StellarAssetClient,
        Address, Env,
    };

    #[test]
    fn rebalance_moves_funds_between_vaults() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &1_000_0000000_i128);

        let musdc_a_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let vault_a_id = env.register(MeridianVault, ());
        let vault_a = MeridianVaultClient::new(&env, &vault_a_id);
        vault_a.initialize(&admin, &usdc_id, &musdc_a_id);
        StellarAssetClient::new(&env, &musdc_a_id).set_admin(&vault_a_id);

        let musdc_b_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let vault_b_id = env.register(MeridianVault, ());
        let vault_b = MeridianVaultClient::new(&env, &vault_b_id);
        vault_b.initialize(&admin, &usdc_id, &musdc_b_id);
        StellarAssetClient::new(&env, &musdc_b_id).set_admin(&vault_b_id);

        let router_id = env.register(MeridianRouter, ());
        let router = MeridianRouterClient::new(&env, &router_id);

        let amount = 100_0000000_i128;
        vault_a.deposit(&user, &amount, &VaultProtocol::Blend);
        let shares = vault_a.get_position(&user);

        let new_shares = router.rebalance(
            &user,
            &vault_a_id,
            &vault_b_id,
            &shares,
            &1_i128,
            &Protocol::Blend,
        );

        assert!(new_shares > 0);
        assert_eq!(vault_a.get_position(&user), 0);
        assert_eq!(vault_b.get_position(&user), new_shares);
    }

    #[test]
    #[should_panic(expected = "slippage")]
    fn rebalance_reverts_when_min_out_not_met() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &1_000_0000000_i128);

        let musdc_a_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let vault_a_id = env.register(MeridianVault, ());
        let vault_a = MeridianVaultClient::new(&env, &vault_a_id);
        vault_a.initialize(&admin, &usdc_id, &musdc_a_id);
        StellarAssetClient::new(&env, &musdc_a_id).set_admin(&vault_a_id);

        let musdc_b_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let vault_b_id = env.register(MeridianVault, ());
        MeridianVaultClient::new(&env, &vault_b_id).initialize(&admin, &usdc_id, &musdc_b_id);
        StellarAssetClient::new(&env, &musdc_b_id).set_admin(&vault_b_id);

        let router_id = env.register(MeridianRouter, ());
        let router = MeridianRouterClient::new(&env, &router_id);

        let amount = 100_0000000_i128;
        vault_a.deposit(&user, &amount, &VaultProtocol::Blend);
        let shares = vault_a.get_position(&user);

        router.rebalance(
            &user,
            &vault_a_id,
            &vault_b_id,
            &shares,
            &(amount * 2),
            &Protocol::Blend,
        );
    }
}
