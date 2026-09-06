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

RPC_URL="https://soroban-mainnet.stellar.org"
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
  # Circle mainnet USDC Stellar Asset Contract (issuer: GA5ZSEJYB37J...),
  # matching packages/shared/src/constants.ts's CONTRACT_ADDRESSES.mainnet.usdc.
  ["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"]="Circle mainnet USDC"
)

# Empty on purpose: no mainnet Blend pool contract address has been
# independently reviewed and checked into this repo yet (KNOWN_POOLS.mainnet
# only carries DeFiLlama pool UUIDs for APY ranking, not contract addresses;
# CONTRACT_ADDRESSES.mainnet.blend.pool is still ""). Add the reviewed pool
# address here, with a comment naming which Blend pool it is, before it can
# be used by this script. Refusing to run with an empty allow-list is the
# intended behavior, not a bug: it means "nobody has reviewed one yet",
# which is a stronger guarantee than accepting whatever BLEND_POOL_ID names.
declare -A ALLOWED_BLEND_POOL_IDS=()

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

echo "Building contracts..."
cd "$(dirname "$0")/../packages/contracts"
stellar contract build

# `stellar contract build` targets wasm32v1-none, not wasm32-unknown-unknown.
WASM_DIR="target/wasm32v1-none/release"
WASM_VAULT="$WASM_DIR/meridian_vault.wasm"
WASM_BLEND_ADAPTER="$WASM_DIR/meridian_blend_adapter.wasm"
WASM_MUSDC_TOKEN="$WASM_DIR/meridian_musdc_token.wasm"

upload() {
  stellar contract upload --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" --source "$DEPLOYER" --wasm "$1"
}
# The second argument is a salt (pass "" for none, letting the CLI pick one),
# used by the vault deploy below to land at a precomputed address. The third
# is the signing/source identity: DEPLOYER for blend-adapter/mUSDC, which
# need no human auth, or ADMIN_KEY for the vault, whose constructor requires
# ADMIN's own auth. Any arguments after `--` are forwarded to
# `stellar contract deploy` as constructor arguments:
# `deploy "$hash" "" "$DEPLOYER" -- --a 1`.
deploy() {
  local hash="$1"
  local salt="$2"
  local source="$3"
  shift 3
  if [ -n "$salt" ]; then
    stellar contract deploy --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" --source "$source" --wasm-hash "$hash" --salt "$salt" "$@"
  else
    stellar contract deploy --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" --source "$source" --wasm-hash "$hash" "$@"
  fi
}

echo "Uploading vault WASM..."
VAULT_HASH=$(upload "$WASM_VAULT")
echo "Uploading blend-adapter WASM..."
BLEND_ADAPTER_HASH=$(upload "$WASM_BLEND_ADAPTER")
echo "Uploading mUSDC token WASM..."
MUSDC_TOKEN_HASH=$(upload "$WASM_MUSDC_TOKEN")

# The vault takes admin/usdc/musdc/adapter as constructor arguments (#551,
# same fix #505/#550 already applied to the adapters/mUSDC), so its state is
# set inside its own deploying transaction with no intervening ledger for a
# front-run to land in. But blend-adapter and mUSDC's own constructors need
# the vault's address, and the vault won't exist to hand out an address
# until it is deployed. Soroban contract IDs are deterministic from
# (network, source account, salt) alone, independent of the wasm being
# deployed, so a random salt lets the vault's address be computed up front,
# handed to blend-adapter/mUSDC, and then the vault is deployed to that
# exact same address with a matching --salt. The source account used here
# must be ADMIN (not DEPLOYER), since it must match whoever actually sources
# the vault's own deploy below.
VAULT_SALT=$(openssl rand -hex 32)
VAULT_ID=$(stellar contract id wasm --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" --source-account "$ADMIN_ADDRESS" --salt "$VAULT_SALT")
echo "Reserved vault contract ID: $VAULT_ID"

# The adapter's vault/pool/USDC wiring is passed as constructor arguments, so
# it is set inside this same CreateContract operation. There is deliberately
# no separate initialize() step: that gap was front-runnable (#505).
echo "Deploying blend-adapter (vault=$VAULT_ID, pool=$BLEND_POOL_ID, usdc=$USDC_ID)..."
BLEND_ADAPTER_ID=$(deploy "$BLEND_ADAPTER_HASH" "" "$DEPLOYER" \
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
MUSDC_ID=$(deploy "$MUSDC_TOKEN_HASH" "" "$DEPLOYER" \
  -- --admin "$VAULT_ID" --decimals 7 --name "Meridian USDC" --symbol mUSDC)
echo "mUSDC contract ID: $MUSDC_ID"

# Deploying with the same salt used to reserve VAULT_ID above lands the
# vault at that exact address. Its constructor sets admin/usdc/musdc/adapter
# in this same transaction and requires admin.require_auth(), which Soroban
# only honors here for the transaction's own source account, so this is
# sourced by ADMIN_KEY, not DEPLOYER.
echo "Deploying vault (admin=$ADMIN_ADDRESS, usdc=$USDC_ID, musdc=$MUSDC_ID, adapter=$BLEND_ADAPTER_ID)..."
ACTUAL_VAULT_ID=$(deploy "$VAULT_HASH" "$VAULT_SALT" "$ADMIN_KEY" \
  -- --admin "$ADMIN_ADDRESS" --usdc "$USDC_ID" --musdc "$MUSDC_ID" --adapter "$BLEND_ADAPTER_ID")

# blend-adapter and mUSDC above were already deployed with VAULT_ID
# permanently baked into their constructor state, and neither has an
# in-place upgrade path. This should never fail (the same source account
# and salt computed VAULT_ID and are used again here), but if it ever did,
# silently trusting the precomputed address instead of checking would leave
# both permanently wired to a vault address that isn't the one actually
# deployed.
if [ "$ACTUAL_VAULT_ID" != "$VAULT_ID" ]; then
  echo "ERROR: vault deployed to $ACTUAL_VAULT_ID, but blend-adapter and mUSDC" >&2
  echo "were already wired to the precomputed address $VAULT_ID." >&2
  exit 1
fi
echo "vault contract ID: $VAULT_ID"

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
