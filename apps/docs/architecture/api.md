# API Layer

Meridian has two API implementations that share the same interface:

| Implementation              | Used in           | Location    |
| --------------------------- | ----------------- | ----------- |
| Vercel serverless functions | Production        | `api/v1/`   |
| Fastify server              | Local development | `apps/api/` |

## Endpoints

### `GET /api/v1/vaults`

Returns all available vaults with live APY and TVL.

**Response**

```json
{
  "vaults": [
    {
      "id": "blend-usdc-variable",
      "protocol": "blend",
      "asset": "USDC",
      "name": "Blend Capital",
      "label": "Variable Rate",
      "apy": 7.42,
      "tvl": 1240000,
      "userBalance": 0,
      "riskLevel": "safe"
    }
  ],
  "recommendedVaultId": "blend-usdc-variable",
  "updatedAt": "2026-05-26T12:00:00.000Z",
  "cached": false
}
```

APY data is sourced from DeFiLlama's `/pools` endpoint filtered to Stellar stablecoins. Pools are matched against a curated registry (`known-pools.ts`) that maps DeFiLlama pool UUIDs to protocol metadata. `recommendedVaultId` is the vault with the highest APY, or `null` if none qualifies.

### `GET /api/v1/vaults/:vaultId`

Returns a single vault or 404.

### `GET /api/v1/positions/:publicKey`

Returns the user's on-chain position.

**Response**

```json
{
  "positions": [
    {
      "vaultId": "blend-usdc-variable",
      "shares": 100.0,
      "deposited": 100.0,
      "earned": 2.34,
      "entryTime": 1716729600
    }
  ]
}
```

Reads position data directly from the vault contract via `simulateTransaction`. Returns an empty array if the wallet holds no shares.

### `POST /api/v1/tx/deposit`

Builds an unsigned Soroban deposit transaction.

**Request**

```json
{
  "walletAddress": "G...",
  "vaultId": "blend-usdc-variable",
  "amount": "100.00"
}
```

**Response**

```json
{
  "xdr": "AAAAAgAAAAA...",
  "fee": "12345"
}
```

The `xdr` field is a base64-encoded unsigned `TransactionEnvelope`. The `fee` is the simulated resource fee in stroops. The client must forward the XDR to Freighter for signing before submitting.

### `POST /api/v1/tx/withdraw`

Builds an unsigned Soroban withdraw transaction.

**Request**

```json
{
  "walletAddress": "G...",
  "vaultId": "blend-usdc-variable",
  "shares": "95.5000000"
}
```

**Response:** same shape as deposit: `{ xdr, fee }`.

### `POST /api/v1/tx/add-trustline`

Builds an unsigned transaction that adds the mUSDC trustline to the caller's account. Must be submitted before a first deposit.

**Request**

```json
{ "walletAddress": "G..." }
```

**Response**

```json
{ "xdr": "AAAAAgAAAAA..." }
```

### `POST /api/v1/tx/submit`

Submits a Freighter-signed XDR to the Stellar network.

**Request**

```json
{ "xdr": "AAAAAgAAAAA..." }
```

**Response**

```json
{ "hash": "abc123..." }
```

A `PENDING` or `DUPLICATE` status from the Stellar RPC is treated as success and the hash is returned. An `ERROR` status returns 500.

## Serverless vs Fastify

Both implementations share the same handler logic and import from the same workspace packages (`@meridian/shared`, `@meridian/stellar-sdk-helpers`).

The Vercel functions (`api/v1/`) import workspace packages that are pre-built into self-contained JS bundles by `scripts/build-vercel.sh` before deployment. The build script runs esbuild on each package's entry point with `--bundle --packages=external`, inlining all relative imports while leaving npm packages external. Vercel then bundles the resulting `dist/index.js` files alongside the function handlers at deploy time.

The Fastify server (`apps/api/`) runs the same packages directly via `tsx`, which handles TypeScript natively in the development process.

## Vault ID to protocol mapping

When building a deposit transaction, the `vaultId` is mapped to the `Protocol` enum expected by the vault contract:

| Vault ID prefix | Protocol   |
| --------------- | ---------- |
| `blend-`        | `Blend`    |
| `defindex-`     | `DeFindex` |

Any other prefix returns a 500 with a clear mapping error.
