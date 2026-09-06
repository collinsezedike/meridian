# Trust Model

## Scope

This page explains what the vault's admin key can and cannot do. It is deliberately separate from:

- [`docs/contracts.md`](https://github.com/drydocs/meridian/blob/main/docs/contracts.md), which describes the contract architecture and why no in-place upgrade path exists.
- The admin-key-risk report in issue #557, which identified the original, unbounded slippage and no-timelock problems.
- The incident-response runbook tracked as #721, which describes the operational steps to take if the key is suspected to be compromised.

This page is about the *on-chain authority* that the admin key grants. It does not cover the web application's security model, the wallet UX, or the keeper infrastructure. Those are documented separately and should not be conflated with the key's authority.

## What the admin key can do

The admin key is the only address that can invoke the vault's admin-authority entry points. In the current contract, those are:

- `set_paused`
- `set_adapter`
- `transfer_admin`
- `begin_migration`
- `migrate_adapter`

Each of these exists for a specific operational reason:

- `set_paused` can stop new deposits from being accepted. Withdrawals remain open, so this is a safety rail, not a way to trap funds.
- `set_adapter` can point the vault at a different adapter after it has no outstanding position, which is useful when an adapter is broken or being deliberately replaced at genesis.
- `transfer_admin` nominates a new admin, but the handover only completes after the nominee accepts it with their own signature. This prevents a typo'd or unreachable address from becoming permanent.
- `begin_migration` records a snapshot of a candidate adapter's valuation and the current ledger sequence.
- `migrate_adapter` then moves the vault's entire position to that adapter, subject to the slippage and stability checks described below.

## What the admin key structurally cannot do

There is no in-place upgrade path for the vault or adapter contracts. The admin key cannot rewrite the contract logic, change the mUSDC token's supply, or retroactively alter someone's deposited amount. This is a deliberate architectural choice, not an oversight; see the [immutability section](https://github.com/drydocs/meridian/blob/main/docs/contracts.md#contract-immutability) in the contracts overview.

That also means:

- A compromised admin key cannot replace deployed code with a backdoored version.
- A lost admin key cannot be recovered by “re-issuing” one from the same contract.
- A migration, even if initiated by an attacker, still has to pass the on-chain checks; it cannot arbitrarily mint or burn shares.

## Why the admin key still matters

Although the admin key cannot rewrite the contract, it can still use the existing entry points to move the vault between adapters. In a live vault with users, the high-impact operation is `migrate_adapter`; `set_adapter` is specifically constrained to a vault with no outstanding position, so it is not the relevant path while shares are outstanding. If the key is compromised, an attacker may still be able to `set_paused` or `migrate_adapter` within the on-chain invariants.

The 5% slippage ceiling and one-day migration cooldown introduced by issue #557 reduce the blast radius, but they do not remove the underlying risk. They bound how badly and how quickly an attacker can move value, and they create a monitoring window for the system to notice an unusual `begin_migration` call.

## What happens if the key is lost

If the admin key is lost, the admin-authority entry points above become unusable. Deposits, withdrawals, and ordinary vault activity remain available to users. Since the contract is immutable, there is no way to install a new admin key into the same deployment.

The only available remedy is to deploy a fresh vault and migrate user positions to it. That is a materially worse outcome than rotating a secret, but it is still possible without rewriting the deployed code.

## What happens if the key is compromised

A compromised admin key gives the attacker the ability to invoke the admin-authority entry points directly. The consequences depend on which entry point they call, but a few examples are:

- They can `set_paused` to halt new deposits.
- They can `transfer_admin` to themselves, handing over future control of the vault.
- They can `begin_migration` and later `migrate_adapter`, subject to the migration invariants and the 1-day cooldown.

The slippage and cooldown limits from #557 make this less catastrophic than an unconstrained admin, but they are not a substitute for key custody.

## Operational response

If the admin key is suspected lost or compromised, the response is operational, not on-chain:

1. Stop using the compromised secret.
2. Deploy a fresh vault and migrate user positions to it.
3. Revoke the old key's ability to sign any further transactions.
4. Restore normal deposits and withdrawals on the new deployment.

The detailed operational steps are tracked in the incident-response runbook, issue #721. That runbook should be the primary reference for what to do when the key itself is the problem; this page is the underlying trust-model description that explains why the key has that much authority in the first place.

## Cross-references

- [`docs/contracts.md`](https://github.com/drydocs/meridian/blob/main/docs/contracts.md) — contract architecture and the reason no in-place upgrade path exists.
- Issue #557 — the admin-key-risk analysis and the fix that introduced the slippage ceiling and migration cooldown.
- Issue #721 — operational incident-response runbook for suspected key loss or compromise.

## Summary

The admin key is intentionally narrow but still high-authority. It can move the vault between adapters and halt new deposits. It cannot rewrite the contract or bypass the on-chain invariants that keep user balances consistent. The practical result is that a lost key makes the admin-authority path unavailable, while a compromised key requires an operational response and, if necessary, a fresh deployment.
