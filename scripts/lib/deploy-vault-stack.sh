# Shared vault + BlendAdapter + mUSDC deployment orchestration for
# scripts/deploy-testnet.sh and scripts/deploy-mainnet.sh (#717).
#
# Extracted because the constructor-argument wiring below has changed three
# times already for front-running fixes (#505, #550, #551): keeping two
# independent copies of it risked the mainnet script silently deploying with
# stale wiring, or failing mid-sequence with blend-adapter/mUSDC already
# permanently wired to the wrong vault address, the next time either
# contract's constructor changes and only one copy gets updated.
#
# Sourced, not executed directly. The caller must set these before sourcing:
#
#   STELLAR_NETWORK_FLAGS  Array of stellar-cli network flags, e.g.
#                          (--network testnet) or
#                          (--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE").
#   DEPLOYER               Stellar secret key/alias that funds and signs the
#                          blend-adapter/mUSDC deploys.
#   ADMIN_ADDRESS          Vault admin public key (G...).
#   ADMIN_KEY              Signing key for ADMIN_ADDRESS, or "" if
#                          unavailable. When empty, deploy_vault_stack still
#                          deploys blend-adapter/mUSDC (wired to the vault's
#                          precomputed address) but leaves the vault itself
#                          undeployed and prints the command for ADMIN's
#                          holder to run themselves, matching
#                          deploy-testnet.sh's original fallback behavior.
#                          deploy-mainnet.sh hard-requires ADMIN_KEY to be
#                          set before it ever sources this file, so that
#                          fallback is dead code there, not a mainnet-unsafe
#                          convenience reintroduced through the back door.
#   USDC_ID                USDC contract address to wire the adapter to.
#   BLEND_POOL_ID          Blend pool contract address to wire the adapter to.
#
# After sourcing, call deploy_vault_stack. It sets VAULT_ID, BLEND_ADAPTER_ID,
# MUSDC_ID, and VAULT_INITIALIZED (1 if the vault itself was deployed this
# run, 0 if the ADMIN_KEY-empty fallback above was taken) as globals.

upload() {
  stellar contract upload "${STELLAR_NETWORK_FLAGS[@]}" --source "$DEPLOYER" --wasm "$1"
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
    stellar contract deploy "${STELLAR_NETWORK_FLAGS[@]}" --source "$source" --wasm-hash "$hash" --salt "$salt" "$@"
  else
    stellar contract deploy "${STELLAR_NETWORK_FLAGS[@]}" --source "$source" --wasm-hash "$hash" "$@"
  fi
}

deploy_vault_stack() {
  echo "Building contracts..."
  cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/contracts"
  stellar contract build

  # `stellar contract build` targets wasm32v1-none, not wasm32-unknown-unknown.
  local wasm_dir="target/wasm32v1-none/release"
  local wasm_vault="$wasm_dir/meridian_vault.wasm"
  local wasm_blend_adapter="$wasm_dir/meridian_blend_adapter.wasm"
  local wasm_musdc_token="$wasm_dir/meridian_musdc_token.wasm"

  echo "Uploading vault WASM..."
  local vault_hash
  vault_hash=$(upload "$wasm_vault")
  echo "Uploading blend-adapter WASM..."
  local blend_adapter_hash
  blend_adapter_hash=$(upload "$wasm_blend_adapter")
  echo "Uploading mUSDC token WASM..."
  local musdc_token_hash
  musdc_token_hash=$(upload "$wasm_musdc_token")

  # The vault takes admin/usdc/musdc/adapter as constructor arguments (#551,
  # same fix #505/#550 already applied to the adapters/mUSDC), so its state
  # is set inside its own deploying transaction with no intervening ledger
  # for a front-run to land in. But blend-adapter and mUSDC's own
  # constructors need the vault's address, and the vault won't exist to
  # hand out an address until it is deployed. Soroban contract IDs are
  # deterministic from (network, source account, salt) alone, independent
  # of the wasm being deployed, so a random salt lets the vault's address
  # be computed up front, handed to blend-adapter/mUSDC, and then the vault
  # is deployed to that exact same address with a matching --salt. The
  # source account used here must be ADMIN_ADDRESS, since it must match
  # whoever actually sources the vault's own deploy below.
  local vault_salt
  vault_salt=$(openssl rand -hex 32)
  VAULT_ID=$(stellar contract id wasm "${STELLAR_NETWORK_FLAGS[@]}" --source-account "$ADMIN_ADDRESS" --salt "$vault_salt")
  echo "Reserved vault contract ID: $VAULT_ID"

  # The adapter's vault/pool/USDC wiring is passed as constructor arguments,
  # so it is set inside this same CreateContract operation. There is
  # deliberately no separate initialize() step: that gap was front-runnable
  # (#505).
  echo "Deploying blend-adapter (vault=$VAULT_ID, pool=$BLEND_POOL_ID, usdc=$USDC_ID)..."
  BLEND_ADAPTER_ID=$(deploy "$blend_adapter_hash" "" "$DEPLOYER" \
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
  MUSDC_ID=$(deploy "$musdc_token_hash" "" "$DEPLOYER" \
    -- --admin "$VAULT_ID" --decimals 7 --name "Meridian USDC" --symbol mUSDC)
  echo "mUSDC contract ID: $MUSDC_ID"

  # Deploying with the same salt used to reserve VAULT_ID above lands the
  # vault at that exact address. Its constructor sets
  # admin/usdc/musdc/adapter in this same transaction and requires
  # admin.require_auth(), which Soroban only honors here for the
  # transaction's own source account, so this must be sourced by ADMIN_KEY,
  # not DEPLOYER.
  VAULT_INITIALIZED=0
  if [ -n "$ADMIN_KEY" ]; then
    echo "Deploying vault (admin=$ADMIN_ADDRESS, usdc=$USDC_ID, musdc=$MUSDC_ID, adapter=$BLEND_ADAPTER_ID)..."
    local actual_vault_id
    actual_vault_id=$(deploy "$vault_hash" "$vault_salt" "$ADMIN_KEY" \
      -- --admin "$ADMIN_ADDRESS" --usdc "$USDC_ID" --musdc "$MUSDC_ID" --adapter "$BLEND_ADAPTER_ID")

    # blend-adapter and mUSDC above were already deployed with VAULT_ID
    # baked permanently into their constructor state, and neither has an
    # in-place upgrade path. This should never fail (the same source
    # account and salt computed VAULT_ID and are used again here), but if
    # it ever did, silently trusting the precomputed address instead of
    # checking would leave both permanently wired to a vault address that
    # isn't the one actually deployed.
    if [ "$actual_vault_id" != "$VAULT_ID" ]; then
      echo "ERROR: vault deployed to $actual_vault_id, but blend-adapter and mUSDC" >&2
      echo "were already wired to the precomputed address $VAULT_ID." >&2
      exit 1
    fi
    echo "vault contract ID: $VAULT_ID"
    VAULT_INITIALIZED=1
  else
    # ADMIN is separate from DEPLOYER and ADMIN_KEY was not supplied, so
    # this run has no key that can source the vault's deploy transaction
    # and satisfy its constructor's admin.require_auth(). Unlike the old
    # deploy-then-initialize() flow, there is no claimable window: the
    # vault simply does not exist on-chain yet. Run this command as the
    # ADMIN key holder to complete the deployment, using the exact salt
    # below.
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
    echo "  stellar contract deploy ${STELLAR_NETWORK_FLAGS[*]} --source <your-ADMIN-key-or-alias> \\"
    echo "    --wasm-hash $vault_hash --salt $vault_salt \\"
    echo "    -- --admin $ADMIN_ADDRESS --usdc $USDC_ID --musdc $MUSDC_ID --adapter $BLEND_ADAPTER_ID"
    echo ""
  fi
}
