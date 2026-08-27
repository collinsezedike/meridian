# mUSDC liquidation sequencing constraint — no collateral integrations before #504 ships

**Labels:** enhancement  
**Area:** Contracts, Docs  
**Network:** testnet, mainnet  
**Breaking change:** No

---

## Summary

Track a sequencing constraint against #504: no third-party integration should
list mUSDC as accepted collateral until #504 has shipped. A liquidation on any
lending market that accepts mUSDC is an ordinary, automated event that transfers
mUSDC to a liquidator with no relationship to Meridian — turning the still-open
transfer desync into unrecoverable third-party value destruction rather than a
two-party problem.

## Motivation

mUSDC is a genuine, freely transferable Stellar Asset Contract token, and #504's
own fix rationale explicitly endorses that — reading share ownership from the
mUSDC token itself rather than an internal balance map is the correct direction.
That also means mUSDC is usable as collateral on integrations Meridian doesn't
control.

The issue is sequencing: a liquidation is entirely ordinary on any lending market,
and unlike a plain wallet-to-wallet transfer there is no cooperating counterparty
to reason with or wait for a fix. The mUSDC moves to the liquidator's wallet the
moment the liquidation executes. If the vault's `withdraw` still reads from a
stale internal map at that point, neither the original holder nor the liquidator
can redeem, and there is no recovery path.

#504's issue body and acceptance criteria are framed entirely around the
two-party transfer scenario. The liquidation angle isn't mentioned there, so it's
easy for the fix to land without explicitly covering this vector if it isn't
called out.

## Proposed Solution

No new code change beyond #504's already-agreed fix (derive share ownership from
the real mUSDC token balance rather than the internal `Balance` map). This issue
exists purely to enforce a sequencing constraint:

1. **#504 must ship** (and be verifiably live on the target network) before any
   collateral integration lists mUSDC as an accepted asset.
2. **#504's PR description** (or a linked comment) should reference this
   liquidation scenario explicitly, so reviewers know it is covered by the same
   fix and can confirm it before merging.

## Alternatives Considered

**Restrict mUSDC transferability** to prevent it being used as collateral
entirely: rejected by #504's own agreed direction. mUSDC being a real,
transferable share token is a legitimate, intended use case — the goal is to
make transfers safe, not to prevent them.

## Acceptance Criteria

- [ ] Sequencing constraint documented: no mUSDC-as-collateral integration goes
      live before #504 has shipped on the same network.
- [ ] #504's PR description or a linked note references the liquidation scenario
      explicitly, so reviewers know the same fix covers it.

## Additional Context

The transfer desync that #504 fixes is documented directly in the contract source.
`packages/contracts/vault/src/lib.rs`, `DataKey` enum comment:

> Deliberately no per-address share balance. mUSDC is a normal transferable
> token, so an internal balance map is a second source of truth that a plain
> `transfer()` silently invalidates: the recipient could not withdraw (the map
> still said zero) and the sender could not either (the map let the check pass,
> then `burn` failed on tokens they no longer held), permanently stranding the
> position. Share ownership is read from the mUSDC token itself, which is the
> only balance the `burn` actually operates on.

And in `deposit`:

> the vault has no hook on mUSDC's built-in `transfer`, so those records were
> never cleared the way a full `withdraw()` clears them

A liquidation is the exact same mechanism — a `transfer()` the vault has no hook
on — but with the additional property that the recipient (the liquidator) has no
reason to know the position is stranded and no recourse once it is.
