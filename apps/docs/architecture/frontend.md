# Frontend

## Stack

| Concern | Library |
|---|---|
| Bundler | Vite 8 |
| UI | React 19 |
| Styling | Tailwind CSS |
| Server state | TanStack Query v5 |
| Client state | Zustand |
| Wallet | `@stellar/freighter-api` |

## Component structure

The UI is intentionally minimal: one page, one panel.

```
App
├── Header
│   └── WalletConnect        # Connect / disconnect Freighter
└── VaultPanel               # All deposit/withdraw interaction
    ├── Hero (APY, TVL, Route)
    ├── Position summary     # Shown when connected with a position
    ├── Tab switcher         # Deposit | Withdraw
    └── Action area          # Amount input + submit button
```

`VaultPanel` is the only stateful UI component. It pulls from three hooks:

- `useVaults()`: fetches `GET /api/v1/vaults`, picks `bestVault` by APY.
- `usePositions(publicKey)`: fetches `GET /api/v1/positions/:key`, enabled only when connected.
- `useVaultActions()`: orchestrates the build → sign → submit cycle.

## Data flow

```
useVaults
  └─► api.getVaults() → GET /api/v1/vaults
        └─► returns ApiVault[]
              └─► bestVault = vaults.reduce(highest APY)

useVaultActions.deposit(amount, vaultId)
  └─► api.buildDeposit({ walletAddress, vaultId, amount })
        └─► POST /api/v1/tx/deposit → { xdr, fee }
              └─► signTransaction(xdr, networkPassphrase)  ← Freighter
                    └─► api.submitTx({ xdr: signedXdr })
                          └─► POST /api/v1/tx/submit → { hash }
                                └─► queryClient.invalidateQueries(["positions"])
```

## Wallet store

`useWalletStore` (Zustand) holds:

```typescript
{
  connected: boolean;
  publicKey: string | null;
  network: "testnet" | "mainnet";
}
```

Connection is triggered by `useWalletConnect`, which calls `connectFreighter()` and persists the public key. The store is not persisted to `localStorage`; users re-connect on page load.

## API client

`apps/web/src/lib/api.ts` exports a typed `api` object wrapping `fetch`. All requests go to `${VITE_API_URL}/api/v1/...`. In local dev `VITE_API_URL` is empty and Vite proxies `/api` to `http://localhost:3001`. In production it is also empty and requests hit the same Vercel origin where the serverless functions live.

Error handling in `apiFetch` normalises error bodies from multiple shapes (Fastify, Vercel, nested objects) into a single string, with `Request failed (${status})` as the fallback for HTTP/2 responses where `statusText` is empty.
