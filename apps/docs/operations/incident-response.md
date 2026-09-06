# Incident Response

## Scope

This runbook is for the operational side of responding to a live incident once the contracts are already deployed. It is deliberately separate from [`mainnet-deployment.md`](./mainnet-deployment.md), which covers the deploy-time script, constructor wiring, and rollback plan.

Use this page when the code is already live and something is actively going wrong: an admin key is suspected compromised, a keeper secret is suspected compromised, or you need to stop new deposits immediately.

## Emergency pause

`set_paused(true)` is the fastest available lever.

It only blocks new deposits. Withdrawals remain open, so this is a safety rail, not a way to trap funds. Use it when you need to stop fresh deposits while you investigate, or when you suspect the admin key and need to reduce new exposure.

To clear it once the incident is resolved, call `set_paused(false)`.

## Admin-key compromise

If the admin secret is suspected compromised:

1. Call `set_paused(true)`.
2. Rotate the admin key with `transfer_admin(newAdmin)`.
3. Have the new admin call `accept_admin()`.
4. Resume `set_paused(false)` only after the new key is confirmed and the old secret is retired.

There is no in-place upgrade path, so a compromised admin key cannot be “patched out” of the same deployment. The vault and adapter contracts stay immutable; the practical response is key handover and operational cleanup.

If the admin secret is lost rather than compromised, `transfer_admin` cannot help; the only available remedy is to deploy a fresh vault and migrate users to it.

## Keeper-secret rotation

`MERIDIAN_KEEPER_SECRET_KEY` and `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY` are operational secrets. If either is suspected exposed:

1. Replace the secret in the deployment environment.
2. Update `MERIDIAN_KEEPER_SECRET_KEY` / `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY` to the new value.
3. Restart the scheduled keepers so they pick up the new secret.
4. Treat the old secret as retired and do not reuse it in any future rollout.

If the compromised secret is also the vault admin, follow the admin-key rotation steps above before resuming.

## What this does not cover

This runbook does not cover a bug in the deployed contract code itself. Because there is no in-place upgrade path, a vault bug requires a full redeployment and cutover, not a patch. That is out of scope here and belongs to the deployment/rollback plan.

## Cross-references

- [`mainnet-deployment.md`](./mainnet-deployment.md) — deploy-time prerequisites and rollback plan.
- [`../overview/introduction.md`](../overview/introduction.md) — product and protocol overview.
