# Why Meridian

## The problem

Inflation in many West African economies regularly exceeds 20% annually. Local savings accounts often yield less than inflation, eroding purchasing power for anyone holding domestic currency. USD-denominated savings accounts exist, but access requires extensive KYC, minimum balances, and geographic restrictions that exclude most of the region.

Crypto wallets remove the access barriers but introduce a different problem: yield is fragmented across protocols. A user who wants to put idle USDC to work must research Blend, DeFindex, and others separately, compare rates manually, and execute separate transactions for each. Most do not bother.

## Why Stellar

Stellar is the right infrastructure layer for this use case:

- **Fees below $0.01 per transaction.** On-chain activity is economically viable for small savers, not just whales.
- **5-second finality.** Deposits and withdrawals settle in a single block.
- **Native USDC.** Circle issues USDC natively on Stellar, avoiding bridge risk.
- **Soroban smart contracts.** Composable, auditable yield logic runs directly on-chain with Rust-level safety guarantees.

## Why an aggregator

Yield rates on DeFi protocols are not static. A protocol offering 8% today may offer 5% next week as utilization changes. Without active monitoring, a depositor's funds sit in a suboptimal position indefinitely.

Meridian solves this by separating the routing decision (off-chain, by the API reading live rates) from the custody decision (on-chain, by the vault contract). Every deposit records which protocol was chosen, and the user signs off on that choice before any funds move. The choice doesn't have to be made again: a scheduled keeper re-checks rates on an ongoing basis and moves the vault's position to a better-yielding protocol automatically, so a deposit made once keeps chasing the best available rate without the user coming back to do it manually.

## The target user

Meridian is built for users in West Africa and other emerging markets who:

- Already hold USDC or are comfortable acquiring it through a local exchange
- Have a Freighter wallet or are willing to set one up
- Want dollar-denominated yield without navigating multiple protocols themselves

The UI is intentionally minimal. No charts to interpret, no liquidity pools to research. One number (APY), one action (deposit).
