# Contracts

Meridian ships one Soroban contract: a **vault** that holds user USDC and mints
share tokens, protocol-specific work is delegated to a swappable adapter, not
a second contract.

The vault lives under `packages/contracts/vault/` and is built with the
Stellar CLI (`stellar contract build`). The deploy script at
`scripts/deploy-testnet.sh` builds, uploads, and deploys it.

## Vault (`meridian-vault`)

Source: [`packages/contracts/vault/src/lib.rs`](../packages/contracts/vault/src/lib.rs)

The vault is a protocol-agnostic coordinator, not a direct protocol integration:
it holds no opinion about where funds actually earn yield and delegates all
protocol-specific work to a swappable **adapter** contract (`BlendAdapter` or
`DefindexAdapter`), selected via `set_adapter`. Users deposit USDC and receive
mUSDC share tokens whose redemption value grows with yield accrued in the
active adapter's underlying protocol.

There is exactly one vault deployment per supported asset (one for USDC), not
one per protocol. There is no `route_to` or protocol-selection parameter on
`deposit`, which protocol funds reach is determined entirely by whichever
adapter the vault currently has set, not by anything the caller passes in,
and not by which of several vault instances a deposit went to, there's only
one. Moving the vault's exposure from one protocol to another (e.g. Blend to
DeFindex) is `migrate_adapter`, an admin/keeper-triggered operation on the
vault itself: it never touches any individual depositor's mUSDC balance,
since shares are priced against the vault's total value, not reissued per
protocol. See
[`apps/docs/architecture/vault-contract.md`](../apps/docs/architecture/vault-contract.md)
for `migrate_adapter`'s full behavior and its slippage/value-preservation
invariant.

A virtual share/asset offset of 1 000 stroops is applied to all price
calculations to neutralise the first-depositor inflation attack: an attacker
who donates USDC directly to the adapter recovers only a negligible fraction of
the donation, making the skim unprofitable.

For the full entry-point reference, error codes, and storage layout, see
[`apps/docs/architecture/vault-contract.md`](../apps/docs/architecture/vault-contract.md),
that page is the canonical, detailed reference.

## Building and deploying

```bash
# Build the vault (and adapters)
cd packages/contracts
stellar contract build

# Deploy to testnet (requires DEPLOYER env var set to a funded secret key)
bash scripts/deploy-testnet.sh
```

The deploy script prints the deployed contract IDs. Add them to `.env` as
`VAULT_CONTRACT_ID`.
