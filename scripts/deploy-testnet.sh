#!/usr/bin/env bash
set -euo pipefail

# Deploy a full, freshly-wired Meridian coordinator vault stack to Stellar
# testnet: vault, router, and a BlendAdapter, initialized and linked together.
# Use this to stand up a brand new environment. To push new adapter code to
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

# Existing testnet assets/protocol contracts this deployment wires the vault
# to. Override via env var to point at different addresses.
USDC_ID="${USDC_ID:-CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU}"
BLEND_POOL_ID="${BLEND_POOL_ID:-CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF}"

echo "Building contracts..."
cd "$(dirname "$0")/../packages/contracts"
stellar contract build

# `stellar contract build` targets wasm32v1-none, not wasm32-unknown-unknown.
WASM_DIR="target/wasm32v1-none/release"
WASM_VAULT="$WASM_DIR/meridian_vault.wasm"
WASM_ROUTER="$WASM_DIR/meridian_router.wasm"
WASM_BLEND_ADAPTER="$WASM_DIR/meridian_blend_adapter.wasm"

DEPLOYER_ADDRESS=$(stellar keys address "$DEPLOYER")
ADMIN_ADDRESS="${ADMIN:-$DEPLOYER_ADDRESS}"
if [ -z "$ADMIN" ]; then
  echo "WARNING: ADMIN not set, defaulting vault admin to the deployer's own address."
  echo "The deployer key will then also be the permanent admin key. Set ADMIN"
  echo "explicitly to a separate, durable key to avoid this."
fi

upload() {
  stellar contract upload --network "$NETWORK" --source "$DEPLOYER" --wasm "$1"
}
deploy() {
  stellar contract deploy --network "$NETWORK" --source "$DEPLOYER" --wasm-hash "$1"
}

echo "Uploading vault WASM..."
VAULT_HASH=$(upload "$WASM_VAULT")
echo "Uploading router WASM..."
ROUTER_HASH=$(upload "$WASM_ROUTER")
echo "Uploading blend-adapter WASM..."
BLEND_ADAPTER_HASH=$(upload "$WASM_BLEND_ADAPTER")

echo "Deploying vault..."
VAULT_ID=$(deploy "$VAULT_HASH")
echo "vault contract ID: $VAULT_ID"

echo "Deploying router..."
ROUTER_ID=$(deploy "$ROUTER_HASH")
echo "router contract ID: $ROUTER_ID"

echo "Deploying blend-adapter..."
BLEND_ADAPTER_ID=$(deploy "$BLEND_ADAPTER_HASH")
echo "blend-adapter contract ID: $BLEND_ADAPTER_ID"

echo "Deploying mUSDC share token (Stellar Asset Contract)..."
MUSDC_ID=$(stellar contract asset deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --asset "MUSDC:$DEPLOYER_ADDRESS")
echo "mUSDC contract ID: $MUSDC_ID"

echo "Initializing blend-adapter (pool=$BLEND_POOL_ID, usdc=$USDC_ID)..."
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER" --id "$BLEND_ADAPTER_ID" \
  -- initialize --vault "$VAULT_ID" --pool "$BLEND_POOL_ID" --usdc "$USDC_ID"

echo "Initializing vault (admin=$ADMIN_ADDRESS, usdc=$USDC_ID, musdc=$MUSDC_ID, adapter=$BLEND_ADAPTER_ID)..."
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER" --id "$VAULT_ID" \
  -- initialize \
  --admin "$ADMIN_ADDRESS" --usdc "$USDC_ID" --musdc "$MUSDC_ID" --adapter "$BLEND_ADAPTER_ID"

echo "Setting the vault as mUSDC's admin so it can mint/burn shares..."
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER" --id "$MUSDC_ID" \
  -- set_admin --new-admin "$VAULT_ID"

echo "Initializing router (admin=$ADMIN_ADDRESS)..."
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER" --id "$ROUTER_ID" \
  -- initialize --admin "$ADMIN_ADDRESS"

echo "Allowlisting this deployment's vault on the router..."
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER" --id "$ROUTER_ID" \
  -- add_vault --vault "$VAULT_ID"

echo ""
echo "Done. Add these to your .env:"
echo "  VAULT_CONTRACT_ID=$VAULT_ID"
echo "  ROUTER_CONTRACT_ID=$ROUTER_ID"
echo "  BLEND_ADAPTER_CONTRACT_ID=$BLEND_ADAPTER_ID"
echo "  MUSDC_CONTRACT_ID=$MUSDC_ID"
