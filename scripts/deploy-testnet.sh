#!/usr/bin/env bash
set -euo pipefail

# Deploy a full, freshly-wired Meridian coordinator vault stack to Stellar
# testnet: vault and a BlendAdapter, initialized and linked together. Use
# this to stand up a brand new environment. To push new adapter code to
# an ALREADY-LIVE vault without redeploying the vault itself, use
# scripts/redeploy-blend-adapter.sh instead.
#
# Usage: bash scripts/deploy-testnet.sh

NETWORK="testnet"

# DEPLOYER must be set in the environment and funded via friendbot. It only
# pays fees and signs setup transactions; it does not need to be kept around
# afterward. Vault admin control is a separate identity (see ADMIN below).
: "${DEPLOYER:?DEPLOYER env var required (Stellar secret key)}"

# ADMIN is the address that becomes the deployed vault's permanent admin
# (set_admin, set_paused, set_adapter). Deliberately independent of DEPLOYER
# so the deploying key can be thrown away after the run. Defaults to
# DEPLOYER's own address for local/dev convenience, but should always be
# explicitly set to a durable key (or multisig) for anything beyond a
# throwaway testnet run, and MUST be set explicitly ahead of any mainnet
# deployment. Public key only (G...), not a secret key.
: "${ADMIN:=}"

# ADMIN_KEY is the signing key (a Stellar secret key, or a `stellar keys`
# alias) for the ADMIN address above. Optional, and only meaningful when ADMIN
# is a separate address from DEPLOYER. initialize() calls
# admin.require_auth(), so that call has to carry ADMIN's own signature, which
# DEPLOYER cannot produce. When ADMIN_KEY is supplied the script signs and
# submits initialize() itself, in the same run as the deploy.
#
# Supply it whenever the key is available on the machine running this script.
# initialize() is callable by ANY address (it only checks that whatever admin
# it is handed authorizes the call), so a deployed-but-uninitialized vault can
# be claimed by whoever calls initialize() first, with themselves as admin.
# Leaving ADMIN_KEY unset means the script cannot close that window itself and
# has to hand the call off, so the window stays open until the key holder runs
# it. See the warning the script prints in that case.
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

# Resolve identities and fail fast on a mismatched ADMIN_KEY, before spending
# a build and four transactions to find out the initialize() signature will
# not satisfy admin.require_auth().
if [ -n "$ADMIN_KEY" ]; then
  ADMIN_KEY_ADDRESS=$(stellar keys address "$ADMIN_KEY")
  if [ "$ADMIN_KEY_ADDRESS" != "$ADMIN_ADDRESS" ]; then
    echo "ERROR: ADMIN_KEY resolves to $ADMIN_KEY_ADDRESS, but ADMIN is $ADMIN_ADDRESS." >&2
    echo "They have to be the same identity: initialize() is signed by ADMIN_KEY and" >&2
    echo "its admin.require_auth() is checked against ADMIN." >&2
    exit 1
  fi
fi

echo "Building contracts..."
cd "$(dirname "$0")/../packages/contracts"
stellar contract build

# `stellar contract build` targets wasm32v1-none, not wasm32-unknown-unknown.
WASM_DIR="target/wasm32v1-none/release"
WASM_VAULT="$WASM_DIR/meridian_vault.wasm"
WASM_BLEND_ADAPTER="$WASM_DIR/meridian_blend_adapter.wasm"

upload() {
  stellar contract upload --network "$NETWORK" --source "$DEPLOYER" --wasm "$1"
}
# Any arguments after the wasm hash are forwarded to `stellar contract deploy`,
# which is how constructor arguments are passed: `deploy "$hash" -- --a 1`.
deploy() {
  local hash="$1"
  shift
  stellar contract deploy --network "$NETWORK" --source "$DEPLOYER" --wasm-hash "$hash" "$@"
}

echo "Uploading vault WASM..."
VAULT_HASH=$(upload "$WASM_VAULT")
echo "Uploading blend-adapter WASM..."
BLEND_ADAPTER_HASH=$(upload "$WASM_BLEND_ADAPTER")

echo "Deploying vault..."
VAULT_ID=$(deploy "$VAULT_HASH")
echo "vault contract ID: $VAULT_ID"

# The adapter's vault/pool/USDC wiring is passed as constructor arguments, so
# it is set inside this same CreateContract operation. There is deliberately no
# separate initialize() step: that gap was front-runnable (#505).
echo "Deploying blend-adapter (vault=$VAULT_ID, pool=$BLEND_POOL_ID, usdc=$USDC_ID)..."
BLEND_ADAPTER_ID=$(deploy "$BLEND_ADAPTER_HASH" \
  -- --vault "$VAULT_ID" --pool "$BLEND_POOL_ID" --usdc "$USDC_ID")
echo "blend-adapter contract ID: $BLEND_ADAPTER_ID"

echo "Deploying mUSDC share token (Stellar Asset Contract)..."
MUSDC_ID=$(stellar contract asset deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --asset "MUSDC:$DEPLOYER_ADDRESS")
echo "mUSDC contract ID: $MUSDC_ID"

# Whichever key signs initialize(), it has to be the one that controls
# ADMIN_ADDRESS: initialize() calls admin.require_auth() on the address it is
# handed. When ADMIN defaults to DEPLOYER's own address, DEPLOYER's signature
# satisfies both roles. When ADMIN is separate, only ADMIN_KEY can sign it.
VAULT_INITIALIZED=0
INIT_SOURCE=""
if [ "$ADMIN_ADDRESS" = "$DEPLOYER_ADDRESS" ]; then
  INIT_SOURCE="$DEPLOYER"
elif [ -n "$ADMIN_KEY" ]; then
  INIT_SOURCE="$ADMIN_KEY"
fi

if [ -n "$INIT_SOURCE" ]; then
  echo "Initializing vault (admin=$ADMIN_ADDRESS, usdc=$USDC_ID, musdc=$MUSDC_ID, adapter=$BLEND_ADAPTER_ID)..."
  stellar contract invoke \
    --network "$NETWORK" --source "$INIT_SOURCE" --id "$VAULT_ID" \
    -- initialize \
    --admin "$ADMIN_ADDRESS" --usdc "$USDC_ID" --musdc "$MUSDC_ID" --adapter "$BLEND_ADAPTER_ID"
  VAULT_INITIALIZED=1
else
  # ADMIN is separate from DEPLOYER and its key was not supplied, so this run
  # cannot sign initialize() at all: submitting with only DEPLOYER's signature
  # fails with "Missing signing key for account $ADMIN_ADDRESS". Print the
  # call for the ADMIN key holder to run, and be explicit that the vault is
  # exposed until they do. Set ADMIN_KEY to avoid this path entirely.
  echo ""
  echo "WARNING: the vault at $VAULT_ID is deployed but NOT INITIALIZED."
  echo ""
  echo "ADMIN ($ADMIN_ADDRESS) is separate from DEPLOYER and ADMIN_KEY was not"
  echo "set, so this run has no key that can satisfy initialize()'s"
  echo "admin.require_auth(). initialize() is callable by anyone, so until the"
  echo "call below lands, anyone watching testnet can call it first with their"
  echo "own address as admin. They would then own set_adapter/set_admin/"
  echo "set_paused on this vault, and the real initialize() would fail with"
  echo "AlreadyInitialized. Run this NOW, or re-run the script with ADMIN_KEY"
  echo "set and abandon this vault:"
  echo ""
  echo "  stellar contract invoke --network $NETWORK --source <your-ADMIN-key-or-alias> \\"
  echo "    --id $VAULT_ID -- initialize \\"
  echo "    --admin $ADMIN_ADDRESS --usdc $USDC_ID --musdc $MUSDC_ID --adapter $BLEND_ADAPTER_ID"
  echo ""
  echo "Then confirm the vault is yours before funding it:"
  echo ""
  echo "  stellar contract invoke --network $NETWORK --source $DEPLOYER_ADDRESS \\"
  echo "    --send=no --id $VAULT_ID -- get_admin"
  echo ""
fi

echo "Setting the vault as mUSDC's admin so it can mint/burn shares..."
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER" --id "$MUSDC_ID" \
  -- set_admin --new-admin "$VAULT_ID"

echo ""
echo "Done. Add these to your .env:"
echo "  VAULT_CONTRACT_ID=$VAULT_ID"
echo "  BLEND_ADAPTER_CONTRACT_ID=$BLEND_ADAPTER_ID"
echo "  MUSDC_CONTRACT_ID=$MUSDC_ID"
if [ "$VAULT_INITIALIZED" -eq 0 ]; then
  echo ""
  echo "Reminder: the vault is deployed but NOT YET INITIALIZED, and claimable"
  echo "by anyone until it is. See the initialize() command printed above for"
  echo "the ADMIN key holder to run."
fi
