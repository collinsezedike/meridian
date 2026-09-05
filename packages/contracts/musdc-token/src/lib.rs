#![no_std]

// mUSDC as a custom SEP-41 token, replacing the plain Stellar Asset Contract
// it shipped as. A SAC's `transfer` is the built-in implementation with no
// hook for the vault to observe — see #504's `hasBasis` guard and
// `MeridianVault::get_principal`'s doc comment for the honest-`0` degradation
// that gap forced. This contract exists to close it: `transfer`/
// `transfer_from` notify the configured vault contract after moving
// balances, and the vault splits `Principal`/`Entry` between sender and
// receiver pro-rata (see `MeridianVault::on_transfer`).
//
// The vault is this token's sole admin, set once at `initialize` and never
// rotated — unlike the vault's own `transfer_admin`/`accept_admin`, there is
// no handover path here, since "the admin" is structurally always whichever
// vault contract this token backs, not an operator key. `mint` is the only
// admin-gated entrypoint; everything else (`transfer`, `transfer_from`,
// `approve`, `burn`, `burn_from`) is the standard SEP-41 surface, callable by
// any holder exactly like a classic asset.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, token::TokenInterface, Address, Env, String, Symbol,
};

const ADMIN: Symbol = symbol_short!("ADMIN");
const DECIMALS: Symbol = symbol_short!("DECIMALS");
const NAME: Symbol = symbol_short!("NAME");
const SYMBOL: Symbol = symbol_short!("SYMBOL");
const TOTAL_SUP: Symbol = symbol_short!("TOTAL_SUP");

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Balance(Address),
    Allowance(Address, Address),
}

#[contracttype]
#[derive(Clone)]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// `initialize` was called on a contract that already has an admin set.
    AlreadyInitialized = 1,
    /// A call was made before `initialize`.
    NotInitialized = 2,
    /// `transfer`/`transfer_from`/`burn`/`burn_from`/`mint` was called with a
    /// non-positive amount.
    NonPositiveAmount = 3,
    /// The `from`/`spender` address does not hold or was not granted enough
    /// balance/allowance to cover the requested amount.
    InsufficientBalance = 4,
    /// `approve` was called with a negative `expiration_ledger` relative to
    /// the current ledger (SEP-41 requires it to be non-negative and, for a
    /// nonzero amount, in the future).
    InvalidExpirationLedger = 5,
    /// A balance or total-supply update would overflow `i128`.
    Overflow = 6,
}

/// The vault's side of the transfer notification, called after balances have
/// already moved. Kept minimal — just what this token calls — mirroring how
/// `vault/src/lib.rs` defines its own `AdapterClient` locally rather than
/// depending on a specific adapter crate; the vault crate doesn't need to
/// depend on this one for that reason, only for its own integration tests.
#[contractclient(name = "VaultCallbackClient")]
pub trait VaultCallback {
    /// `sender_balance_before`/`receiver_balance_before` are `from`'s and
    /// `to`'s balances immediately before this transfer (`from`'s new
    /// balance plus `amount`, `to`'s new balance minus `amount`). Passed
    /// explicitly rather than read back from this token by the vault, since
    /// this contract already has both on hand from computing the transfer
    /// itself — avoiding extra cross-contract calls and any question of
    /// whether a re-read after the balance writes could observe something
    /// other than "immediately before".
    fn on_transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
        sender_balance_before: i128,
        receiver_balance_before: i128,
    );
}

#[contract]
pub struct MusdcToken;

#[contractimpl]
impl MusdcToken {
    /// Runs inside the `CreateContract` host operation that deploys this
    /// token, in the same transaction, so it is never observable on-ledger
    /// in an uninitialized state. `admin` is the vault this token backs —
    /// see the module doc comment for why that's permanent, unlike the
    /// vault's own admin.
    ///
    /// This is the same fix blend-adapter's `__constructor` applies for
    /// #505: `initialize()` below has no authorization check by design
    /// (there is no admin in storage yet to check the caller against), so
    /// if deploy and initialize were two separate transactions, anyone
    /// watching the ledger could land `initialize()` first with their own
    /// address as `admin`, permanently owning mint rights over this token.
    /// Removing the intervening ledger closes that window entirely, rather
    /// than trying to authorize a call that has no identity to authorize
    /// against yet.
    pub fn __constructor(env: Env, admin: Address, decimals: u32, name: String, symbol: String) {
        Self::init_state(&env, &admin, decimals, name, symbol);
    }

    /// Retained for symmetry with blend-adapter's own `initialize`, and as
    /// a manual fallback. Unreachable on any token deployed from this WASM:
    /// `__constructor` has already set `ADMIN`, so every call here returns
    /// `AlreadyInitialized`.
    pub fn initialize(
        env: Env,
        admin: Address,
        decimals: u32,
        name: String,
        symbol: String,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        Self::init_state(&env, &admin, decimals, name, symbol);
        Ok(())
    }

    /// The write half of initialization, shared by `__constructor` and
    /// `initialize` so the two can never set up different state. Not
    /// `pub`, so it is not callable from outside the contract.
    fn init_state(env: &Env, admin: &Address, decimals: u32, name: String, symbol: String) {
        env.storage().instance().set(&ADMIN, admin);
        env.storage().instance().set(&DECIMALS, &decimals);
        env.storage().instance().set(&NAME, &name);
        env.storage().instance().set(&SYMBOL, &symbol);
        env.storage().instance().set(&TOTAL_SUP, &0_i128);
    }

    /// Admin-only (the vault). Mints new shares — called from
    /// `MeridianVault::deposit`. There is no direct-to-holder mint path:
    /// only the vault can grow supply, exactly as only the vault could mint
    /// mUSDC as a SAC via `StellarAssetClient::mint` before this contract
    /// replaced it.
    ///
    /// No `Result` return: this matches `MusdcAdminInterface` on the vault
    /// side (`vault/src/lib.rs`), which calls this the same panic-through
    /// way it already calls the adapter interface's non-`Result` methods.
    pub fn mint(env: Env, to: Address, amount: i128) {
        if let Err(err) = Self::require_admin(&env) {
            panic_with_error!(&env, err);
        }
        if amount <= 0 {
            panic_with_error!(&env, ContractError::NonPositiveAmount);
        }
        let balance = Self::read_balance(&env, &to);
        let new_balance = balance
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::Overflow));
        Self::write_balance(&env, &to, new_balance);
        let supply: i128 = env.storage().instance().get(&TOTAL_SUP).unwrap_or(0);
        let new_supply = supply
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::Overflow));
        env.storage().instance().set(&TOTAL_SUP, &new_supply);

        // ADMIN is guaranteed set: require_admin above already succeeded.
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        env.events()
            .publish((Symbol::new(&env, "mint"), admin, to), amount);
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&TOTAL_SUP).unwrap_or(0)
    }

    pub fn admin(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn read_balance(env: &Env, id: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id.clone()))
            .unwrap_or(0)
    }

    fn write_balance(env: &Env, id: &Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Balance(id.clone()), &amount);
    }

    fn read_allowance(env: &Env, from: &Address, spender: &Address) -> AllowanceValue {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        match env.storage().temporary().get::<_, AllowanceValue>(&key) {
            Some(allowance) if allowance.expiration_ledger >= env.ledger().sequence() => allowance,
            // Either never set, or expired: SEP-41 treats an expired
            // allowance as zero rather than as whatever amount was last
            // recorded.
            _ => AllowanceValue {
                amount: 0,
                expiration_ledger: 0,
            },
        }
    }

    fn write_allowance(
        env: &Env,
        from: &Address,
        spender: &Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage().temporary().set(
            &key,
            &AllowanceValue {
                amount,
                expiration_ledger,
            },
        );
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        let allowance = Self::read_allowance(env, from, spender);
        if allowance.amount < amount {
            panic_with_error!(env, ContractError::InsufficientBalance);
        }
        if amount > 0 {
            Self::write_allowance(
                env,
                from,
                spender,
                allowance.amount - amount,
                allowance.expiration_ledger,
            );
        }
    }

    fn do_transfer(env: &Env, from: &Address, to: &Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(env, ContractError::NonPositiveAmount);
        }
        let from_balance = Self::read_balance(env, from);
        if from_balance < amount {
            panic_with_error!(env, ContractError::InsufficientBalance);
        }

        // A self-transfer is a legitimate, effect-free no-op (classic
        // Stellar payments allow it too) — skip both the balance writes and
        // the vault notification entirely. Without this, reading `to`'s
        // balance *after* `from`'s write below would read `from`'s
        // just-decremented value when `from == to`, handing the vault a
        // `receiver_balance_before` that doesn't reflect any real prior
        // state and corrupting the pro-rata Principal/Entry split for no
        // reason (nothing actually changed hands).
        if from == to {
            return;
        }

        let new_from_balance = from_balance
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::Overflow));
        Self::write_balance(env, from, new_from_balance);
        let to_balance = Self::read_balance(env, to);
        let new_to_balance = to_balance
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::Overflow));
        Self::write_balance(env, to, new_to_balance);

        env.events().publish(
            (Symbol::new(env, "transfer"), from.clone(), to.clone()),
            amount,
        );

        // Notify the vault after the balances have actually moved, so a
        // vault that reads this token's balance() mid-callback (it doesn't
        // today, but nothing prevents it) sees the post-transfer state.
        // `sender_balance_before`/`receiver_balance_before` are `from_balance`/
        // `to_balance`, both captured above before their respective writes.
        let admin: Address = match env.storage().instance().get(&ADMIN) {
            Some(admin) => admin,
            // Unreachable in practice: `transfer`/`transfer_from` can only
            // be called after `initialize` sets ADMIN (every other entry
            // point that touches balances requires it too), kept as a
            // defensive no-op rather than a panic so an already-successful
            // balance move is never rolled back by this notification step.
            None => return,
        };
        VaultCallbackClient::new(env, &admin).on_transfer(
            from,
            to,
            &amount,
            &from_balance,
            &to_balance,
        );
    }
}

#[contractimpl]
impl TokenInterface for MusdcToken {
    fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::read_allowance(&env, &from, &spender).amount
    }

    fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32) {
        from.require_auth();
        if amount < 0 {
            panic_with_error!(&env, ContractError::NonPositiveAmount);
        }
        // SEP-41: a nonzero approval must expire in the future; a zero
        // approval (revoking) may set any expiration, including 0.
        if amount > 0 && expiration_ledger < env.ledger().sequence() {
            panic_with_error!(&env, ContractError::InvalidExpirationLedger);
        }
        Self::write_allowance(&env, &from, &spender, amount, expiration_ledger);

        env.events().publish(
            (Symbol::new(&env, "approve"), from, spender),
            (amount, expiration_ledger),
        );
    }

    fn balance(env: Env, id: Address) -> i128 {
        Self::read_balance(&env, &id)
    }

    fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::do_transfer(&env, &from, &to, amount);
    }

    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, ContractError::NonPositiveAmount);
        }
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::do_transfer(&env, &from, &to, amount);
    }

    fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, ContractError::NonPositiveAmount);
        }
        let balance = Self::read_balance(&env, &from);
        if balance < amount {
            panic_with_error!(&env, ContractError::InsufficientBalance);
        }
        let new_balance = balance
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::Overflow));
        Self::write_balance(&env, &from, new_balance);
        let supply: i128 = env.storage().instance().get(&TOTAL_SUP).unwrap_or(0);
        let new_supply = supply
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::Overflow));
        env.storage().instance().set(&TOTAL_SUP, &new_supply);

        env.events()
            .publish((Symbol::new(&env, "burn"), from), amount);
    }

    fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, ContractError::NonPositiveAmount);
        }
        Self::spend_allowance(&env, &from, &spender, amount);
        let balance = Self::read_balance(&env, &from);
        if balance < amount {
            panic_with_error!(&env, ContractError::InsufficientBalance);
        }
        let new_balance = balance
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::Overflow));
        Self::write_balance(&env, &from, new_balance);
        let supply: i128 = env.storage().instance().get(&TOTAL_SUP).unwrap_or(0);
        let new_supply = supply
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::Overflow));
        env.storage().instance().set(&TOTAL_SUP, &new_supply);

        env.events()
            .publish((Symbol::new(&env, "burn"), from), amount);
    }

    fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DECIMALS).unwrap_or(7)
    }

    fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&NAME)
            .unwrap_or_else(|| String::from_str(&env, ""))
    }

    fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&SYMBOL)
            .unwrap_or_else(|| String::from_str(&env, ""))
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
        testutils::{Address as _, Events as _, Ledger as _},
        vec, Env, IntoVal,
    };

    // Records the most recent on_transfer call it received, so tests can
    // assert exactly what the token told the vault, independent of the real
    // vault's own accounting logic (that side is covered in
    // packages/contracts/vault/src/lib.rs's own tests, against this real
    // token contract). Every test here only ever triggers one transfer, so a
    // single-slot record (plus a count, to also assert calls that shouldn't
    // happen didn't) is enough — no need for a Vec of a custom contracttype
    // struct here.
    #[contract]
    pub struct MockVault;

    const CALL_COUNT: Symbol = symbol_short!("CALLCOUNT");
    const LAST_FROM: Symbol = symbol_short!("LASTFROM");
    const LAST_TO: Symbol = symbol_short!("LASTTO");
    const LAST_AMT: Symbol = symbol_short!("LASTAMT");
    const LAST_S_BAL: Symbol = symbol_short!("LASTSBAL");
    const LAST_R_BAL: Symbol = symbol_short!("LASTRBAL");

    #[contractimpl]
    impl MockVault {
        pub fn on_transfer(
            env: Env,
            from: Address,
            to: Address,
            amount: i128,
            sender_balance_before: i128,
            receiver_balance_before: i128,
        ) {
            let count: u32 = env.storage().instance().get(&CALL_COUNT).unwrap_or(0);
            env.storage().instance().set(&CALL_COUNT, &(count + 1));
            env.storage().instance().set(&LAST_FROM, &from);
            env.storage().instance().set(&LAST_TO, &to);
            env.storage().instance().set(&LAST_AMT, &amount);
            env.storage()
                .instance()
                .set(&LAST_S_BAL, &sender_balance_before);
            env.storage()
                .instance()
                .set(&LAST_R_BAL, &receiver_balance_before);
        }

        pub fn call_count(env: Env) -> u32 {
            env.storage().instance().get(&CALL_COUNT).unwrap_or(0)
        }

        pub fn last_from(env: Env) -> Address {
            env.storage().instance().get(&LAST_FROM).unwrap()
        }

        pub fn last_to(env: Env) -> Address {
            env.storage().instance().get(&LAST_TO).unwrap()
        }

        pub fn last_amount(env: Env) -> i128 {
            env.storage().instance().get(&LAST_AMT).unwrap()
        }

        pub fn last_sender_balance_before(env: Env) -> i128 {
            env.storage().instance().get(&LAST_S_BAL).unwrap()
        }

        pub fn last_receiver_balance_before(env: Env) -> i128 {
            env.storage().instance().get(&LAST_R_BAL).unwrap()
        }
    }

    fn setup() -> (Env, Address, Address, MusdcTokenClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = env.register(MockVault, ());
        // Registered with constructor arguments, matching every real
        // deployment of this contract: there is no deploy-then-initialize
        // path left to exercise (see __constructor's doc comment).
        let token_id = env.register(
            MusdcToken,
            (
                vault_id.clone(),
                7u32,
                String::from_str(&env, "Meridian USDC"),
                String::from_str(&env, "mUSDC"),
            ),
        );
        let token = MusdcTokenClient::new(&env, &token_id);

        (env, vault_id, token_id, token)
    }

    #[test]
    fn initialize_sets_metadata() {
        let (_env, _vault, _token_id, token) = setup();
        assert_eq!(token.decimals(), 7);
        assert_eq!(token.total_supply(), 0);
    }

    #[test]
    fn reinitializing_fails() {
        let (env, vault_id, _token_id, token) = setup();
        let result = token.try_initialize(
            &vault_id,
            &7,
            &String::from_str(&env, "x"),
            &String::from_str(&env, "x"),
        );
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn mint_increases_balance_and_supply() {
        let (env, _vault, _token_id, token) = setup();
        let user = Address::generate(&env);

        token.mint(&user, &100);

        assert_eq!(token.balance(&user), 100);
        assert_eq!(token.total_supply(), 100);
    }

    #[test]
    fn mint_publishes_a_mint_event() {
        let (env, admin, token_id, token) = setup();
        let user = Address::generate(&env);

        token.mint(&user, &100);

        let events = env.events().all();
        let (contract, topics, data) = events.get(events.len() - 1).unwrap();
        assert_eq!(contract, token_id);
        assert_eq!(
            topics,
            vec![
                &env,
                Symbol::new(&env, "mint").into_val(&env),
                admin.into_val(&env),
                user.into_val(&env)
            ]
        );
        let amount: i128 = data.into_val(&env);
        assert_eq!(amount, 100);
    }

    #[test]
    fn transfer_publishes_a_transfer_event() {
        let (env, _vault, token_id, token) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        token.mint(&alice, &100);

        token.transfer(&alice, &bob, &40);

        let events = env.events().all();
        let (contract, topics, data) = events.get(events.len() - 1).unwrap();
        assert_eq!(contract, token_id);
        assert_eq!(
            topics,
            vec![
                &env,
                Symbol::new(&env, "transfer").into_val(&env),
                alice.into_val(&env),
                bob.into_val(&env)
            ]
        );
        let amount: i128 = data.into_val(&env);
        assert_eq!(amount, 40);
    }

    #[test]
    fn burn_publishes_a_burn_event() {
        let (env, _vault, token_id, token) = setup();
        let alice = Address::generate(&env);
        token.mint(&alice, &100);

        token.burn(&alice, &40);

        let events = env.events().all();
        let (contract, topics, data) = events.get(events.len() - 1).unwrap();
        assert_eq!(contract, token_id);
        assert_eq!(
            topics,
            vec![
                &env,
                Symbol::new(&env, "burn").into_val(&env),
                alice.into_val(&env)
            ]
        );
        let amount: i128 = data.into_val(&env);
        assert_eq!(amount, 40);
    }

    #[test]
    fn approve_publishes_an_approve_event() {
        let (env, _vault, token_id, token) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        token.approve(&alice, &bob, &50, &1000);

        let events = env.events().all();
        let (contract, topics, data) = events.get(events.len() - 1).unwrap();
        assert_eq!(contract, token_id);
        assert_eq!(
            topics,
            vec![
                &env,
                Symbol::new(&env, "approve").into_val(&env),
                alice.into_val(&env),
                bob.into_val(&env)
            ]
        );
        let (amount, expiration): (i128, u32) = data.into_val(&env);
        assert_eq!(amount, 50);
        assert_eq!(expiration, 1000);
    }

    #[test]
    #[should_panic]
    fn mint_rejects_a_non_positive_amount() {
        // mint() has no error return (matches MusdcAdminInterface on the
        // vault side), so this panics rather than returning Result.
        let (env, _vault, _token_id, token) = setup();
        let user = Address::generate(&env);
        token.mint(&user, &0);
    }

    #[test]
    fn transfer_moves_balance_and_notifies_the_vault_with_the_pre_transfer_balance() {
        let (env, vault_id, _token_id, token) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        token.mint(&alice, &100);
        // bob already holds a position, so receiver_balance_before must
        // reflect that 10, not the post-transfer 50.
        token.mint(&bob, &10);

        token.transfer(&alice, &bob, &40);

        assert_eq!(token.balance(&alice), 60);
        assert_eq!(token.balance(&bob), 50);

        let mock_vault = MockVaultClient::new(&env, &vault_id);
        assert_eq!(mock_vault.call_count(), 1);
        assert_eq!(mock_vault.last_from(), alice);
        assert_eq!(mock_vault.last_to(), bob);
        assert_eq!(mock_vault.last_amount(), 40);
        // The balances immediately before this transfer, not the
        // post-transfer remainder/total — the whole point of passing them
        // explicitly.
        assert_eq!(mock_vault.last_sender_balance_before(), 100);
        assert_eq!(mock_vault.last_receiver_balance_before(), 10);
    }

    #[test]
    #[should_panic]
    fn transfer_fails_with_insufficient_balance() {
        // transfer() has no error return (TokenInterface), so an
        // insufficient balance panics rather than returning Result.
        let (env, _vault, _token_id, token) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        token.mint(&alice, &10);

        token.transfer(&alice, &bob, &11);
    }

    #[test]
    fn a_self_transfer_is_a_no_op_that_does_not_notify_the_vault() {
        let (env, vault_id, _token_id, token) = setup();
        let alice = Address::generate(&env);
        token.mint(&alice, &100);

        token.transfer(&alice, &alice, &40);

        assert_eq!(token.balance(&alice), 100);
        assert_eq!(MockVaultClient::new(&env, &vault_id).call_count(), 0);
    }

    #[test]
    fn approve_and_transfer_from_spends_the_allowance() {
        let (env, vault_id, _token_id, token) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let spender = Address::generate(&env);
        token.mint(&alice, &100);

        token.approve(&alice, &spender, &50, &1000);
        assert_eq!(token.allowance(&alice, &spender), 50);

        token.transfer_from(&spender, &alice, &bob, &30);

        assert_eq!(token.balance(&alice), 70);
        assert_eq!(token.balance(&bob), 30);
        assert_eq!(token.allowance(&alice, &spender), 20);

        let mock_vault = MockVaultClient::new(&env, &vault_id);
        assert_eq!(mock_vault.call_count(), 1);
        assert_eq!(mock_vault.last_sender_balance_before(), 100);
    }

    #[test]
    #[should_panic]
    fn transfer_from_fails_without_enough_allowance() {
        let (env, _vault, _token_id, token) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let spender = Address::generate(&env);
        token.mint(&alice, &100);
        token.approve(&alice, &spender, &10, &1000);

        token.transfer_from(&spender, &alice, &bob, &11);
    }

    #[test]
    fn an_expired_allowance_reads_as_zero() {
        let (env, _vault, _token_id, token) = setup();
        let alice = Address::generate(&env);
        let spender = Address::generate(&env);
        token.mint(&alice, &100);

        token.approve(&alice, &spender, &50, &5);
        env.ledger().with_mut(|li| li.sequence_number = 10);

        assert_eq!(token.allowance(&alice, &spender), 0);
    }

    #[test]
    #[should_panic]
    fn an_expired_allowance_cannot_be_spent() {
        let (env, _vault, _token_id, token) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let spender = Address::generate(&env);
        token.mint(&alice, &100);

        token.approve(&alice, &spender, &50, &5);
        env.ledger().with_mut(|li| li.sequence_number = 10);

        token.transfer_from(&spender, &alice, &bob, &1);
    }

    #[test]
    fn burn_decreases_balance_and_supply_without_notifying_the_vault() {
        // burn is not a transfer between two holders — there is no receiver
        // side to split Principal/Entry with, so it correctly bypasses
        // on_transfer entirely. The vault's own withdraw() already retires
        // Principal/Entry itself before calling burn (see vault/src/lib.rs).
        let (env, vault_id, _token_id, token) = setup();
        let alice = Address::generate(&env);
        token.mint(&alice, &100);

        token.burn(&alice, &40);

        assert_eq!(token.balance(&alice), 60);
        assert_eq!(token.total_supply(), 60);
        assert_eq!(MockVaultClient::new(&env, &vault_id).call_count(), 0);
    }

    #[test]
    fn burn_from_spends_allowance_and_decreases_supply() {
        let (env, _vault, _token_id, token) = setup();
        let alice = Address::generate(&env);
        let spender = Address::generate(&env);
        token.mint(&alice, &100);
        token.approve(&alice, &spender, &40, &1000);

        token.burn_from(&spender, &alice, &40);

        assert_eq!(token.balance(&alice), 60);
        assert_eq!(token.total_supply(), 60);
        assert_eq!(token.allowance(&alice, &spender), 0);
    }

    #[test]
    fn name_and_symbol_round_trip() {
        let (env, _vault, _token_id, token) = setup();
        assert_eq!(token.name(), String::from_str(&env, "Meridian USDC"));
        assert_eq!(token.symbol(), String::from_str(&env, "mUSDC"));
    }
}
