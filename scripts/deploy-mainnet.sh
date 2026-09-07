#!/usr/bin/env bash
set -euo pipefail

# Deploy a full, freshly-wired Meridian coordinator vault stack to Stellar
# mainnet: vault, a BlendAdapter, and the mUSDC share token, initialized and
# linked together.
#
# Forked from scripts/deploy-testnet.sh (#717) with every testnet-only
# convenience removed rather than gated behind a flag, so there is no way to
# accidentally run this in a mode that behaves like the testnet script:
#   - ADMIN and ADMIN_KEY are hard-required. Neither ever defaults to
#     DEPLOYER, and there is no fallback path that lets this script finish
#     with the vault still undeployed for someone else to complete by hand.
#   - USDC_ID and BLEND_POOL_ID must resolve to an entry in the allow-lists
#     below, not any address an env var happens to name.
#   - An explicit typed confirmation is required before the first network
#     transaction, after every resolved value is printed for review.
#
# See apps/docs/operations/mainnet-deployment.md for the full runbook this
# script is one piece of: key custody, parameter selection, and the go-live
# checklist all live there, not here.
#
# Usage: bash scripts/deploy-mainnet.sh

# The allow-lists below use associative arrays (bash 4+). macOS ships bash
# 3.2 by default (Apple stopped bundling GPLv3 bash), where `declare -A`
# fails with a bare syntax error before any of this script's actual
# validation runs. Fail with a clear message instead.
if ((BASH_VERSINFO[0] < 4)); then
  echo "ERROR: this script requires bash 4 or newer (found $BASH_VERSION)." >&2
  echo "macOS ships bash 3.2 by default; install a newer bash (e.g. 'brew install bash') and invoke it explicitly, e.g. /opt/homebrew/bin/bash scripts/deploy-mainnet.sh" >&2
  exit 1
fi

# These two must match STELLAR_NETWORKS.mainnet in packages/shared/src/constants.ts
# exactly. Not read from that file at runtime (this script has no Node/TS
# dependency), so if that entry is ever updated, update this one by hand in
# the same change: a stale RPC URL fails loudly on the first call, but a
# stale-but-still-valid passphrase would sign transactions for the wrong
# network without any error at all.
RPC_URL="https://mainnet.sorobanrpc.com"
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"

# DEPLOYER must be set in the environment and funded with real XLM: there is
# no Friendbot on mainnet. It only pays fees and signs setup transactions; it
# does not need to be kept around afterward. Vault admin control is a
# separate identity (see ADMIN below).
: "${DEPLOYER:?DEPLOYER env var required (Stellar secret key), funded with real XLM}"

# Unlike deploy-testnet.sh, ADMIN is never defaulted to DEPLOYER's own
# address. A vault whose only admin key is the same disposable key that paid
# for the deploy is exactly the admin-capture failure mode this script
# exists to close off. Should be a hardware-backed or multisig key per
# apps/docs/operations/mainnet-deployment.md, never a throwaway CLI key.
: "${ADMIN:?ADMIN env var required (Stellar public key): a durable, hardware-backed or multisig admin key. See apps/docs/operations/mainnet-deployment.md.}"

# Unlike deploy-testnet.sh, there is no fallback here for a missing
# ADMIN_KEY: that script can finish with the vault undeployed and print a
# command for the ADMIN key holder to run later, which is an acceptable
# testnet convenience but not something to build into a mainnet script. The
# vault's constructor requires ADMIN's own signature (admin.require_auth()),
# so this run cannot complete without it.
: "${ADMIN_KEY:?ADMIN_KEY env var required (Stellar secret key or 'stellar keys' alias for ADMIN)}"

# Mainnet USDC/Blend pool addresses are validated against these checked-in
# allow-lists rather than accepted from any env var override. Add an entry
# only after independently verifying the contract, matching the standard
# already documented for CONTRACT_ADDRESSES.mainnet.usdc in
# packages/shared/src/constants.ts.
declare -A ALLOWED_USDC_IDS=(
  # Circle mainnet USDC Stellar Asset Contract (issuer: GA5ZSEJYB37J...). Must
  # match CONTRACT_ADDRESSES.mainnet.usdc in packages/shared/src/constants.ts
  # exactly; not read from that file at runtime (see the RPC_URL comment
  # above for why), so if it's ever updated there, update it here too.
  ["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"]="Circle mainnet USDC"
)

# Verified two ways before being added here: (1) listed as "Fixed V2" in
# Blend's own blend-utils GitHub repo (mainnet.contracts.json), and (2)
# independently confirmed on-chain via a real mainnet transaction
# (7f19f3af498839bb9deb558fc38b199464044400087b93bd8bd7ac69d79dcf6f) whose
# raw XDR was decoded directly: it calls submit() on this exact contract
# address, and its asset_balance_changes show a real USDC transfer landing
# at this same address. CONTRACT_ADDRESSES.mainnet.blend.pool is still "":
# add the address there too once this pool is actually used for a
# deployment, not before.
declare -A ALLOWED_BLEND_POOL_IDS=(
  ["CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD"]="Blend mainnet USDC pool (Fixed V2)"
)

: "${USDC_ID:?USDC_ID env var required: must match an entry in ALLOWED_USDC_IDS below}"
if [ -z "${ALLOWED_USDC_IDS[$USDC_ID]:-}" ]; then
  echo "ERROR: USDC_ID=$USDC_ID is not in the mainnet allow-list." >&2
  echo "Allowed:" >&2
  for id in "${!ALLOWED_USDC_IDS[@]}"; do
    echo "  $id (${ALLOWED_USDC_IDS[$id]})" >&2
  done
  exit 1
fi

: "${BLEND_POOL_ID:?BLEND_POOL_ID env var required: must match an entry in ALLOWED_BLEND_POOL_IDS below}"
if [ -z "${ALLOWED_BLEND_POOL_IDS[$BLEND_POOL_ID]:-}" ]; then
  echo "ERROR: BLEND_POOL_ID=$BLEND_POOL_ID is not in the mainnet allow-list." >&2
  if [ "${#ALLOWED_BLEND_POOL_IDS[@]}" -eq 0 ]; then
    echo "The allow-list is currently empty: no mainnet Blend pool address has" >&2
    echo "been independently reviewed and added to ALLOWED_BLEND_POOL_IDS in this" >&2
    echo "script yet. Add it there, with a comment naming the pool, before running" >&2
    echo "this deployment." >&2
  else
    echo "Allowed:" >&2
    for id in "${!ALLOWED_BLEND_POOL_IDS[@]}"; do
      echo "  $id (${ALLOWED_BLEND_POOL_IDS[$id]})" >&2
    done
  fi
  exit 1
fi

DEPLOYER_ADDRESS=$(stellar keys address "$DEPLOYER")
ADMIN_ADDRESS="$ADMIN"
ADMIN_KEY_ADDRESS=$(stellar keys address "$ADMIN_KEY")

# Fail fast on a mismatched ADMIN_KEY, before spending a build and three
# transactions to find out the vault's deploy will not satisfy its
# constructor's admin.require_auth().
if [ "$ADMIN_KEY_ADDRESS" != "$ADMIN_ADDRESS" ]; then
  echo "ERROR: ADMIN_KEY resolves to $ADMIN_KEY_ADDRESS, but ADMIN is $ADMIN_ADDRESS." >&2
  echo "They have to be the same identity: the vault's deploy transaction is" >&2
  echo "sourced by ADMIN_KEY and its admin.require_auth() is checked against ADMIN." >&2
  exit 1
fi

if [ "$ADMIN_ADDRESS" = "$DEPLOYER_ADDRESS" ]; then
  echo "ERROR: ADMIN ($ADMIN_ADDRESS) is the same identity as DEPLOYER." >&2
  echo "A mainnet vault's admin must be a separate, durable key from the" >&2
  echo "disposable deploying key. See apps/docs/operations/mainnet-deployment.md." >&2
  exit 1
fi

echo "About to deploy to MAINNET with:"
echo "  DEPLOYER: $DEPLOYER_ADDRESS"
echo "  ADMIN:    $ADMIN_ADDRESS"
echo "  USDC_ID:  $USDC_ID (${ALLOWED_USDC_IDS[$USDC_ID]})"
echo "  BLEND_POOL_ID: $BLEND_POOL_ID (${ALLOWED_BLEND_POOL_IDS[$BLEND_POOL_ID]})"
echo ""
echo "This submits real transactions against real funds and cannot be undone:"
echo "adapters and the vault have no in-place upgrade path."
echo ""
CONFIRMATION=""
# `|| true` so a closed or non-interactive stdin (EOF) doesn't trip `set -e`
# and exit here with a bare shell failure instead of the clear abort message
# below; an empty CONFIRMATION still correctly fails the check that follows.
read -r -p "Type MAINNET to confirm and proceed: " CONFIRMATION || true
if [ "$CONFIRMATION" != "MAINNET" ]; then
  echo "Confirmation not given. Aborting without submitting anything." >&2
  exit 1
fi

# The actual build/upload/deploy sequence is shared with deploy-testnet.sh
# (#717): see scripts/lib/deploy-vault-stack.sh's own header comment for why.
# ADMIN_KEY was already hard-required above, so deploy_vault_stack's
# missing-ADMIN_KEY fallback path (needed for deploy-testnet.sh) is dead
# code here, not a mainnet-unsafe convenience reintroduced through the back door.
STELLAR_NETWORK_FLAGS=(--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")
# shellcheck source=lib/deploy-vault-stack.sh
source "$(dirname "$0")/lib/deploy-vault-stack.sh"
deploy_vault_stack

echo ""
echo "Done. Add these to CONTRACT_ADDRESSES.mainnet / KNOWN_POOLS.mainnet per"
echo "apps/docs/operations/mainnet-deployment.md:"
echo "  VAULT_CONTRACT_ID=$VAULT_ID"
echo "  BLEND_ADAPTER_CONTRACT_ID=$BLEND_ADAPTER_ID"
echo "  MUSDC_CONTRACT_ID=$MUSDC_ID"
echo ""
echo "Next: run the verification chain and reproducible-build check from"
echo "\"Deployment sequence\" in apps/docs/operations/mainnet-deployment.md"
echo "before treating this deployment as live."
