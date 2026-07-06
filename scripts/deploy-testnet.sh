#!/usr/bin/env bash
set -euo pipefail

# Deploy Meridian contracts to Stellar testnet
# Usage: bash scripts/deploy-testnet.sh

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
PASSPHRASE="Test SDF Network ; September 2015"

# DEPLOYER must be set in the environment and funded via friendbot.
: "${DEPLOYER:?DEPLOYER env var required (Stellar secret key)}"

echo "Building contracts..."
cd packages/contracts
stellar contract build

WASM_VAULT="target/wasm32-unknown-unknown/release/meridian_vault.wasm"
WASM_ROUTER="target/wasm32-unknown-unknown/release/meridian_router.wasm"

echo "Uploading vault WASM..."
VAULT_HASH=$(stellar contract upload \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --wasm "$WASM_VAULT")
echo "vault WASM hash: $VAULT_HASH"

echo "Uploading router WASM..."
ROUTER_HASH=$(stellar contract upload \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --wasm "$WASM_ROUTER")
echo "router WASM hash: $ROUTER_HASH"

echo "Deploying vault..."
VAULT_ID=$(stellar contract deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --wasm-hash "$VAULT_HASH")
echo "vault contract ID: $VAULT_ID"

echo "Deploying router..."
ROUTER_ID=$(stellar contract deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --wasm-hash "$ROUTER_HASH")
echo "router contract ID: $ROUTER_ID"

echo ""
echo "Done. Add these to your .env:"
echo "  VAULT_CONTRACT_ID=$VAULT_ID"
echo "  ROUTER_CONTRACT_ID=$ROUTER_ID"
