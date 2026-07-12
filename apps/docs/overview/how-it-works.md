# How It Works

## Deposit flow

```text
User enters amount
       │
       ▼
Frontend POSTs { walletAddress, vaultId, amount }
to POST /api/v1/tx/deposit
       │
       ▼
API fetches account sequence from Soroban RPC
builds invokeHostFunction calling vault.deposit(caller, amount)
simulates transaction to get resource footprint and fee
returns { xdr, fee }
       │
       ▼
Frontend passes XDR to Freighter
User reviews and approves (sees: contract, function, amount)
Freighter returns signed XDR
       │
       ▼
Frontend POSTs { xdr } to POST /api/v1/tx/submit
API forwards to Stellar RPC
       │
       ▼
Transaction settles (~5 seconds)
Vault forwards USDC to its active adapter, which deploys it to the
underlying protocol (Blend or DeFindex), and mints mUSDC shares to
the user's wallet
```

`vault.deposit(caller, amount)` has no protocol-selection parameter. Which protocol the deposit actually reaches is entirely determined by whichever adapter contract the vault currently has set — see [Vault Contract](../architecture/vault-contract.md#adapter-contracts).

## Withdraw flow

Symmetric to deposit. The user specifies a share amount (mUSDC), the API builds a `vault.withdraw(caller, shares)` invocation, Freighter signs, and the vault redeems the proportional adapter position and returns USDC.

## Rate selection

The API reads live APY data differently depending on network:

- **Mainnet**: Blend Capital pools via DeFiLlama's `/pools` endpoint, filtered to Stellar stablecoins and matched against a curated pool registry.
- **Testnet**: queried directly on-chain, since DeFiLlama doesn't index testnet. For the Meridian coordinator vault specifically, the API discovers its live rate by calling `vault.get_adapter()`, then that adapter's `get_pool()`/`get_protocol()`, and branches on the returned protocol string to fetch the appropriate rate (Blend's SDK for `"blend"`; other protocols currently report `0` until wired up). This makes rate discovery self-updating: if the vault's adapter is ever swapped via `set_adapter`, the frontend picks up the new pool and protocol automatically on the next fetch, with no config entry anywhere that could drift out of sync.

The vault with the highest APY among vaults Meridian can actually deposit into becomes `bestVault` and is offered to the user for deposit.

## Share pricing

The vault uses a proportional share model, priced against the active adapter's reported total assets (which includes yield):

```text
shares_minted = deposit_amount * (total_shares + OFFSET) / (adapter_total_assets + OFFSET)
```

`OFFSET` is a small virtual-liquidity constant that makes the first deposit price 1 share ≈ 1 stroop while neutralising the classic first-depositor inflation attack. If the vault has no outstanding shares, this reduces to roughly `shares = amount` (1:1 at genesis). As yield accrues and the adapter's reported total assets grow relative to outstanding shares, the share price rises. Withdrawers receive:

```text
usdc_out = <the adapter's redemption of the caller's proportional share of adapter shares>
```

This means early depositors automatically benefit from yield without any claim or harvest action.

## Security properties

- **No server-side keys.** The API returns unsigned XDR only. Private keys never leave Freighter.
- **User-visible transaction contents.** Freighter shows the exact contract, function, and amount before the user signs — there is no hidden parameter deciding where funds go; that's determined entirely by the vault's current adapter, which is itself a matter of on-chain, auditable state (`vault.get_adapter()`).
- **On-chain state.** USDC balances, share balances, and the active adapter are all stored in Soroban contract storage, auditable by anyone.
