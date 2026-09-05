# How It Works

## Deposit flow

```text
User enters amount
       │
       ▼
Frontend POSTs { walletAddress, vaultId, amount, minSharesOut? }
to POST /api/v1/tx/deposit
       │
       ▼
API fetches account sequence from Soroban RPC
builds invokeHostFunction calling vault.deposit(caller, amount, min_shares_out)
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
the user's wallet (reverting if shares minted < min_shares_out)
```

`vault.deposit(caller, amount, min_shares_out)` has no protocol-selection parameter. Which protocol the deposit actually reaches is entirely determined by whichever adapter contract the vault currently has set — see [Vault Contract](../architecture/vault-contract.md#adapter-contracts).

## Withdraw flow

Symmetric to deposit. The user specifies a share amount (mUSDC), the API builds a `vault.withdraw(caller, shares, min_usdc_out)` invocation, Freighter signs, and the vault redeems the proportional adapter position and returns USDC.

`min_usdc_out` is a caller-supplied floor, not a fixed protocol parameter. The vault's adapter-share ratio is a shared, mutable value, so a concurrent withdrawal by another depositor can shift it between when the API quoted a payout and when this transaction lands. If the delivered amount would fall below the floor, the transaction reverts with a typed `MinAmountOutNotMet` error instead of silently paying out less than the user was shown.

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

## Automatic yield accrual and rebalancing

Deposit and withdraw are the only actions a user ever takes. Two scheduled keeper jobs (GitHub Actions cron, hitting dedicated API routes) handle everything else:

- **Accrual keeper** (every 15 minutes): refreshes the active adapter's cached yield figure, so `total_assets()` reflects interest actually earned rather than going stale between user interactions. Permissionless by design, a duplicate run is harmless.
- **Migration keeper** (hourly): when a different supported protocol is offering meaningfully better yield, moves the vault's entire position to it via `migrate_adapter`, in one atomic, slippage-bounded transaction. Admin-gated, and cross-invocation deduplicated (via a shared claim/lease record) so a slow or retried run can't submit the same migration twice.

Neither keeper changes what a user sees or does; they exist so a deposit made once keeps earning the best available rate without the user ever having to come back and move funds manually.

## Security properties

- **No server-side keys.** The API returns unsigned XDR only. Private keys never leave the user's wallet.
- **User-visible transaction contents.** The wallet shows the exact contract, function, and amount before the user signs. There is no hidden parameter deciding where funds go; that's determined entirely by the vault's current adapter, which is itself a matter of on-chain, auditable state (`vault.get_adapter()`).
- **On-chain state.** USDC balances, share balances, and the active adapter are all stored in Soroban contract storage, auditable by anyone.
- **Slippage-bound withdrawals.** `withdraw()` takes a caller-supplied `min_usdc_out` floor, so a ratio shift from a concurrent withdrawal produces a typed revert instead of a silently reduced payout.
- **Immutable contracts.** No vault or adapter contract exposes an upgrade entry point. Once deployed, contract logic can't be rewritten by anyone, including Meridian, the tradeoff is that a fix requires a fresh deployment (see [Contract immutability](https://github.com/drydocs/meridian/blob/main/docs/contracts.md#contract-immutability)), not an in-place patch.
