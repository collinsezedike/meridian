#!/usr/bin/env bash
set -euo pipefail

# Deploy a full, freshly-wired Meridian coordinator vault stack to Stellar
# testnet: vault, a BlendAdapter, and the mUSDC share token, initialized and
# linked together. Use this to stand up a brand new environment. To push new
# adapter code to an ALREADY-LIVE vault without redeploying the vault itself,
# use scripts/redeploy-blend-adapter.sh instead.
#
# Usage: bash scripts/deploy-testnet.sh

NETWORK="testnet"

# DEPLOYER must be set in the environment and funded via friendbot. It only
# pays fees and signs setup transactions; it does not need to be kept around
# afterward. Vault admin control is a separate identity (see ADMIN below).
: "${DEPLOYER:?DEPLOYER env var required (Stellar secret key)}"

# ADMIN is the address that becomes the deployed vault's permanent admin
# (transfer_admin, set_paused, set_adapter). Deliberately independent of DEPLOYER
# so the deploying key can be thrown away after the run. Defaults to
# DEPLOYER's own address for local/dev convenience, but should always be
# explicitly set to a durable key (or multisig) for anything beyond a
# throwaway testnet run, and MUST be set explicitly ahead of any mainnet
# deployment. Public key only (G...), not a secret key.
: "${ADMIN:=}"

# ADMIN_KEY is the signing key (a Stellar secret key, or a `stellar keys`
# alias) for the ADMIN address above. Required whenever ADMIN is a separate
# address from DEPLOYER. The vault's constructor calls admin.require_auth(),
# and Soroban only honors require_auth() inside a constructor for the address
# that is the deploying transaction's own source account — so ADMIN itself,
# not DEPLOYER, must source and pay for the vault's deploy transaction. This
# is what proves ADMIN's key genuinely exists and its holder consents, unlike
# just being told an address by whoever runs this script. It must therefore
# also be funded (see "Standing up a fresh environment" below).
#
# If ADMIN_KEY is genuinely not available where the script runs, it falls
# back to printing the vault's deploy command for the ADMIN key holder to run
# themselves. Unlike the old two-step deploy-then-initialize() flow, there is
# no "deployed but claimable" window in that case: blend-adapter and mUSDC
# get deployed and permanently wired to the vault's precomputed address, but
# the vault itself simply does not exist on-chain at all until that command
# is run, by ADMIN specifically.
: "${ADMIN_KEY:=}"

# Existing testnet assets/protocol contracts this deployment wires the vault
# to. Override via env var to point at different addresses.
USDC_ID="${USDC_ID:-CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU}"
BLEND_POOL_ID="${BLEND_POOL_ID:-CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF}"

DEPLOYER_ADDRESS=$(stellar keys address "$DEPLOYER")
ADMIN_ADDRESS="${ADMIN:-$DEPLOYER_ADDRESS}"
if [ -z "$ADMIN" ]; then
  echo "WARNING: ADMIN not set, defaulting vault admin to the deployer's own address."
  echo "The deployer key will then also be the permanent admin key. Set ADMIN"
  echo "explicitly to a separate, durable key to avoid this."
fi
# Whenever ADMIN_ADDRESS and DEPLOYER_ADDRESS are the same identity, DEPLOYER's
# own signature already satisfies the vault constructor's admin.require_auth(),
# whether ADMIN was left unset (defaulting above) or explicitly set to the same
# address. Only fill this in when the caller hasn't already supplied their own
# ADMIN_KEY, so an explicit value is never silently overridden.
if [ -z "$ADMIN_KEY" ] && [ "$ADMIN_ADDRESS" = "$DEPLOYER_ADDRESS" ]; then
  ADMIN_KEY="$DEPLOYER"
fi

# Resolve identities and fail fast on a mismatched ADMIN_KEY, before spending
# a build and three transactions to find out the vault's deploy will not
# satisfy its constructor's admin.require_auth().
if [ -n "$ADMIN_KEY" ]; then
  ADMIN_KEY_ADDRESS=$(stellar keys address "$ADMIN_KEY")
  if [ "$ADMIN_KEY_ADDRESS" != "$ADMIN_ADDRESS" ]; then
    echo "ERROR: ADMIN_KEY resolves to $ADMIN_KEY_ADDRESS, but ADMIN is $ADMIN_ADDRESS." >&2
    echo "They have to be the same identity: the vault's deploy transaction is" >&2
    echo "sourced by ADMIN_KEY and its admin.require_auth() is checked against ADMIN." >&2
    exit 1
  fi
elif [ "$ADMIN_ADDRESS" != "$DEPLOYER_ADDRESS" ]; then
  echo "WARNING: ADMIN_KEY not set and ADMIN is separate from DEPLOYER. Blend-adapter"
  echo "and mUSDC will still deploy, wired to the vault's precomputed address, but"
  echo "the vault deploy itself will be printed for the ADMIN key holder to run."
fi

# The actual build/upload/deploy sequence is shared with deploy-mainnet.sh
# (#717): see scripts/lib/deploy-vault-stack.sh's own header comment for why.
STELLAR_NETWORK_FLAGS=(--network "$NETWORK")
# shellcheck source=lib/deploy-vault-stack.sh
source "$(dirname "$0")/lib/deploy-vault-stack.sh"
deploy_vault_stack

echo ""
echo "Done. Add these to your .env:"
echo "  VAULT_CONTRACT_ID=$VAULT_ID"
echo "  BLEND_ADAPTER_CONTRACT_ID=$BLEND_ADAPTER_ID"
echo "  MUSDC_CONTRACT_ID=$MUSDC_ID"
if [ "$VAULT_INITIALIZED" -eq 0 ]; then
  echo ""
  echo "Reminder: the vault is NOT YET DEPLOYED. See the command printed above"
  echo "for the ADMIN key holder to run."
fi
