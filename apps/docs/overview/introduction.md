# Introduction

Meridian is a stablecoin yield aggregator on the Stellar network. Users deposit USDC into a coordinator vault contract and earn yield automatically; the vault delegates to a swappable adapter contract that deploys funds to whichever underlying protocol it's currently pointed at.

## What it does

1. A user connects their Freighter wallet and deposits USDC into the `MeridianVault` coordinator contract.
2. The vault forwards the deposit to its currently active adapter contract, which deploys it to the underlying protocol (today, Blend Capital via `BlendAdapter`; DeFindex support exists as a `DefindexAdapter` contract but has no live testnet vault wired up yet).
3. Meridian compares live APY across supported protocols to recommend which vault to deposit into, but which protocol a given vault's funds actually reach is on-chain state (the vault's active adapter, `vault.get_adapter()`), not a parameter chosen at signing time.
4. The user receives mUSDC share tokens representing their position. Share price appreciates as yield accrues.
5. At any time the user can withdraw by burning their mUSDC shares, receiving USDC plus accumulated yield.

Which protocol a vault routes to can change after a deposit, without any action from the depositor. An hourly migration keeper compares the vault's current adapter against other supported protocols and, when a meaningfully better rate is available, atomically moves the entire position via `migrate_adapter`, slippage-bounded so the move can't complete at a worse value than before it started. A one-off manual swap (`set_adapter`, admin-only) also exists, for cases like recovering from a broken adapter, but ongoing rebalancing is the keeper's job, not something an admin does per-deposit or per-user.

## What it does not do

- Meridian never holds or controls private keys. The server builds an unsigned transaction and returns it to the browser; the user signs with Freighter.
- Meridian does not custody funds in the traditional sense. The vault forwards deposited USDC to its active adapter, which deploys it directly to the underlying protocol (e.g. supplied as collateral in a Blend pool); mUSDC is a custom SEP-41 token representing the resulting position (not a classic Stellar asset — see [Wallet and DEX compatibility](../architecture/vault-contract.md#transferable-shares) for what that trade-off means).
- Meridian does not guarantee yield. APY figures are live estimates from on-chain data and DeFiLlama. Past rates do not predict future rates.

## Status

Meridian is a testnet technical preview. The coordinator vault, `BlendAdapter`, XDR builder, and frontend are all deployed and live on Stellar testnet, with a working end-to-end deposit/withdraw signing flow. A `DefindexAdapter` contract exists but has no live testnet DeFindex vault wired up yet. Mainnet deployment and a security audit are still ahead — see the root [README](https://github.com/drydocs/meridian#project-status) for the current, detailed status.
