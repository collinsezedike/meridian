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
# The second argument is a salt (pass "" for none, letting the CLI pick one),
# used by the vault deploy below to land at a precomputed address. The third
# is the signing/source identity: DEPLOYER for blend-adapter/mUSDC, which
# need no human auth, or ADMIN_KEY for the vault, whose constructor requires
# ADMIN's own auth (see the ADMIN_KEY comment above). Any arguments after
# `--` are forwarded to `stellar contract deploy` as constructor arguments:
# `deploy "$hash" "" "$DEPLOYER" -- --a 1`.
deploy() {
  local hash="$1"
  local salt="$2"
  local source="$3"
  shift 3
  if [ -n "$salt" ]; then
    stellar contract deploy --network "$NETWORK" --source "$source" --wasm-hash "$hash" --salt "$salt" "$@"
  else
    stellar contract deploy --network "$NETWORK" --source "$source" --wasm-hash "$hash" "$@"
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
# from (network, source account, salt) alone, independent of the wasm being
# deployed, so a random salt lets the vault's address be computed up front,
# handed to blend-adapter/mUSDC, and then the vault is deployed to that exact
# same address with a matching --salt. The source account used here must be
# whichever account actually sources the vault's own deploy below (ADMIN, not
# DEPLOYER — see the ADMIN_KEY comment above), since the address depends on it.
VAULT_SALT=$(openssl rand -hex 32)
VAULT_ID=$(stellar contract id wasm --network "$NETWORK" --source-account "$ADMIN_ADDRESS" --salt "$VAULT_SALT")
echo "Reserved vault contract ID: $VAULT_ID"

# The adapter's vault/pool/USDC wiring is passed as constructor arguments, so
# it is set inside this same CreateContract operation. There is deliberately no
# separate initialize() step: that gap was front-runnable (#505).
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

# Deploying with the same salt used to reserve VAULT_ID above lands the vault
# at that exact address. Its constructor sets admin/usdc/musdc/adapter in this
# same transaction and requires admin.require_auth() — which Soroban only
# honors here for the transaction's own source account, so this must be
# sourced by ADMIN_KEY, not DEPLOYER (see the ADMIN_KEY comment above).
VAULT_INITIALIZED=0
if [ -n "$ADMIN_KEY" ]; then
  echo "Deploying vault (admin=$ADMIN_ADDRESS, usdc=$USDC_ID, musdc=$MUSDC_ID, adapter=$BLEND_ADAPTER_ID)..."
  ACTUAL_VAULT_ID=$(deploy "$VAULT_HASH" "$VAULT_SALT" "$ADMIN_KEY" \
    -- --admin "$ADMIN_ADDRESS" --usdc "$USDC_ID" --musdc "$MUSDC_ID" --adapter "$BLEND_ADAPTER_ID")

  # blend-adapter and mUSDC above were already deployed with VAULT_ID baked
  # permanently into their constructor state, and neither has an in-place
  # upgrade path. This should never fail (the same source account and salt
  # computed VAULT_ID and are used again here), but if it ever did, silently
  # trusting the precomputed address instead of checking would leave both
  # permanently wired to a vault address that isn't the one actually deployed.
  if [ "$ACTUAL_VAULT_ID" != "$VAULT_ID" ]; then
    echo "ERROR: vault deployed to $ACTUAL_VAULT_ID, but blend-adapter and mUSDC" >&2
    echo "were already wired to the precomputed address $VAULT_ID." >&2
    exit 1
  fi
  echo "vault contract ID: $VAULT_ID"
  VAULT_INITIALIZED=1
else
  # ADMIN is separate from DEPLOYER and ADMIN_KEY was not supplied, so this
  # run has no key that can source the vault's deploy transaction and satisfy
  # its constructor's admin.require_auth(). Unlike the old deploy-then-
  # initialize() flow, there is no claimable window: the vault simply does
  # not exist on-chain yet. Run this command as the ADMIN key holder to
  # complete the deployment, using the exact salt below.
  echo ""
  echo "blend-adapter and mUSDC are deployed and wired to the vault's reserved"
  echo "address ($VAULT_ID), but the vault itself is NOT YET DEPLOYED."
  echo ""
  echo "ADMIN ($ADMIN_ADDRESS) is separate from DEPLOYER and ADMIN_KEY was not"
  echo "set, so this run has no key that can source the vault's deploy"
  echo "transaction. Run this as the ADMIN key holder, using this exact salt"
  echo "(a different salt lands at a different address than blend-adapter and"
  echo "mUSDC are already wired to):"
  echo ""
  echo "  stellar contract deploy --network $NETWORK --source <your-ADMIN-key-or-alias> \\"
  echo "    --wasm-hash $VAULT_HASH --salt $VAULT_SALT \\"
  echo "    -- --admin $ADMIN_ADDRESS --usdc $USDC_ID --musdc $MUSDC_ID --adapter $BLEND_ADAPTER_ID"
  echo ""
fi

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
