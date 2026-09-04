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
# deployment. Public key only (G...), not a secret key. Never needs to sign
# anything at deploy time (see the constructor note below), so no
# corresponding "ADMIN_KEY" is needed here the way it used to be.
: "${ADMIN:=}"

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

echo "Building contracts..."
cd "$(dirname "$0")/../packages/contracts"
stellar contract build

# `stellar contract build` targets wasm32v1-none, not wasm32-unknown-unknown.
WASM_DIR="target/wasm32v1-none/release"
WASM_VAULT="$WASM_DIR/meridian_vault.wasm"
WASM_BLEND_ADAPTER="$WASM_DIR/meridian_blend_adapter.wasm"
WASM_MUSDC_TOKEN="$WASM_DIR/meridian_musdc_token.wasm"

upload() {
  stellar contract upload --network "$NETWORK" --source "$DEPLOYER" --wasm "$1"
}
# The optional second argument is a salt (pass "" for none, letting the CLI
# pick one), used by the vault deploy below to land at a precomputed address.
# Any arguments after `--` are forwarded to `stellar contract deploy` as
# constructor arguments: `deploy "$hash" "" -- --a 1`.
deploy() {
  local hash="$1"
  local salt="$2"
  shift 2
  if [ -n "$salt" ]; then
    stellar contract deploy --network "$NETWORK" --source "$DEPLOYER" --wasm-hash "$hash" --salt "$salt" "$@"
  else
    stellar contract deploy --network "$NETWORK" --source "$DEPLOYER" --wasm-hash "$hash" "$@"
  fi
}

echo "Uploading vault WASM..."
VAULT_HASH=$(upload "$WASM_VAULT")
echo "Uploading blend-adapter WASM..."
BLEND_ADAPTER_HASH=$(upload "$WASM_BLEND_ADAPTER")
echo "Uploading mUSDC token WASM..."
MUSDC_TOKEN_HASH=$(upload "$WASM_MUSDC_TOKEN")

# The vault now takes admin/usdc/musdc/adapter as constructor arguments too
# (#551, same fix #505/#550 already applied to the adapters/mUSDC), so its
# state is set inside its own deploying transaction with no intervening
# ledger for a front-run to land in. But blend-adapter and mUSDC's own
# constructors need the vault's address, and the vault won't exist to hand
# out an address until it is deployed. Soroban contract IDs are deterministic
# from (network, deployer, salt) alone, independent of the wasm being
# deployed, so a random salt lets the vault's address be computed up front,
# handed to blend-adapter/mUSDC, and then the vault is deployed to that exact
# same address with a matching --salt.
VAULT_SALT=$(openssl rand -hex 32)
VAULT_ID=$(stellar contract id wasm --network "$NETWORK" --source-account "$DEPLOYER" --salt "$VAULT_SALT")
echo "Reserved vault contract ID: $VAULT_ID"

# The adapter's vault/pool/USDC wiring is passed as constructor arguments, so
# it is set inside this same CreateContract operation. There is deliberately no
# separate initialize() step: that gap was front-runnable (#505).
echo "Deploying blend-adapter (vault=$VAULT_ID, pool=$BLEND_POOL_ID, usdc=$USDC_ID)..."
BLEND_ADAPTER_ID=$(deploy "$BLEND_ADAPTER_HASH" "" \
  -- --vault "$VAULT_ID" --pool "$BLEND_POOL_ID" --usdc "$USDC_ID")
echo "blend-adapter contract ID: $BLEND_ADAPTER_ID"

# mUSDC (#578) is a custom SEP-41 token, not a Stellar Asset Contract: it
# carries a transfer callback into the vault so cost basis and entry time
# split correctly between sender and receiver on a transfer, which a bare
# SAC has no hook to support. Its admin ($VAULT_ID) is passed as a
# constructor argument for the same reason as blend-adapter's own wiring
# above: initialize() has no identity to authorize against yet, so a
# deploy-then-initialize gap would be front-runnable the same way #505's
# adapter gap was.
echo "Deploying mUSDC token (admin=$VAULT_ID)..."
MUSDC_ID=$(deploy "$MUSDC_TOKEN_HASH" "" \
  -- --admin "$VAULT_ID" --decimals 7 --name "Meridian USDC" --symbol mUSDC)
echo "mUSDC contract ID: $MUSDC_ID"

# Deploying with the same salt used to reserve VAULT_ID above lands the vault
# at that exact address. Its constructor sets admin/usdc/musdc/adapter in
# this same transaction, so ADMIN never needs to sign anything here (unlike
# the old two-step deploy-then-initialize()) and there is no window where the
# vault exists but is unclaimed.
echo "Deploying vault (admin=$ADMIN_ADDRESS, usdc=$USDC_ID, musdc=$MUSDC_ID, adapter=$BLEND_ADAPTER_ID)..."
ACTUAL_VAULT_ID=$(deploy "$VAULT_HASH" "$VAULT_SALT" \
  -- --admin "$ADMIN_ADDRESS" --usdc "$USDC_ID" --musdc "$MUSDC_ID" --adapter "$BLEND_ADAPTER_ID")

# blend-adapter and mUSDC above were already deployed with VAULT_ID baked
# permanently into their constructor state, and neither has an in-place
# upgrade path. This should never fail (the same DEPLOYER and salt computed
# VAULT_ID and are used again here), but if it ever did, silently trusting
# the precomputed address instead of checking would leave both permanently
# wired to a vault address that isn't the one actually deployed.
if [ "$ACTUAL_VAULT_ID" != "$VAULT_ID" ]; then
  echo "ERROR: vault deployed to $ACTUAL_VAULT_ID, but blend-adapter and mUSDC" >&2
  echo "were already wired to the precomputed address $VAULT_ID." >&2
  exit 1
fi
echo "vault contract ID: $VAULT_ID"

echo ""
echo "Done. Add these to your .env:"
echo "  VAULT_CONTRACT_ID=$VAULT_ID"
echo "  BLEND_ADAPTER_CONTRACT_ID=$BLEND_ADAPTER_ID"
echo "  MUSDC_CONTRACT_ID=$MUSDC_ID"
