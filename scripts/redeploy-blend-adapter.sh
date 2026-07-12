#!/usr/bin/env bash
set -euo pipefail

# Deploy a fresh BlendAdapter and point an already-live coordinator vault at
# it via set_adapter. Use this to push new adapter code (e.g. accrue(),
# get_pool(), get_protocol()) to a live vault without redeploying the vault
# itself, since adapter contracts have no in-place upgrade path (no
# update_current_contract_wasm function) — the only way to update an
# adapter's code is to deploy a new contract and swap the vault onto it.
#
# IMPORTANT: set_adapter resets the vault's adapter-share accounting
# (ADPT_SH) to zero. If any funds are currently deposited through the vault's
# CURRENT adapter, they will become unreachable through the vault's normal
# withdraw flow unless withdrawn before the swap. Confirm no funds are at
# risk before running the final set_adapter step this script prints.
#
# Usage: bash scripts/redeploy-blend-adapter.sh

NETWORK="testnet"

# DEPLOYER must be funded via friendbot. It does not need to be the vault's
# admin to deploy and initialize the new adapter (initialize() has no auth
# check), but it DOES need to be the vault's admin to run the set_adapter
# command this script prints at the end.
: "${DEPLOYER:?DEPLOYER env var required (Stellar secret key)}"

VAULT_ID="${VAULT_ID:-CBK5RI4BCA7TLSD2S5Q5TH2LUQAT55GF34OBTWPFUKWZ5O6YXSQDAWOJ}"
BLEND_POOL_ID="${BLEND_POOL_ID:-CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF}"
USDC_ID="${USDC_ID:-CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU}"

echo "Building blend-adapter..."
cd "$(dirname "$0")/../packages/contracts"
stellar contract build

# `stellar contract build` targets wasm32v1-none, not wasm32-unknown-unknown.
WASM_ADAPTER="target/wasm32v1-none/release/meridian_blend_adapter.wasm"

echo "Uploading blend-adapter WASM..."
ADAPTER_HASH=$(stellar contract upload \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --wasm "$WASM_ADAPTER")
echo "blend-adapter WASM hash: $ADAPTER_HASH"

echo "Deploying new adapter..."
ADAPTER_ID=$(stellar contract deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --wasm-hash "$ADAPTER_HASH")
echo "new adapter contract ID: $ADAPTER_ID"

echo "Initializing adapter (vault=$VAULT_ID, pool=$BLEND_POOL_ID, usdc=$USDC_ID)..."
stellar contract invoke \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --id "$ADAPTER_ID" \
  -- initialize \
  --vault "$VAULT_ID" \
  --pool "$BLEND_POOL_ID" \
  --usdc "$USDC_ID"

echo ""
echo "New adapter deployed and initialized at: $ADAPTER_ID"
echo "It is NOT yet live. The vault ($VAULT_ID) still points at its old adapter."
echo ""
echo "Before continuing: confirm no funds are currently deposited through the"
echo "vault's CURRENT adapter (query vault.get_adapter, then that adapter's"
echo "total_assets). If there are, withdraw them first."
echo ""
echo "Once confirmed safe, point the vault at the new adapter by running"
echo "(requires DEPLOYER to be the vault's admin):"
echo ""
echo "  stellar contract invoke \\"
echo "    --network $NETWORK \\"
echo "    --source \$DEPLOYER \\"
echo "    --id $VAULT_ID \\"
echo "    -- set_adapter --new-adapter $ADAPTER_ID"
echo ""
echo "This step is deliberately not run automatically."
