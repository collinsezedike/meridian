# Frontend

## Stack

| Concern      | Library                                                    |
| ------------ | ---------------------------------------------------------- |
| Bundler      | Vite 8                                                     |
| UI           | React 19                                                   |
| Styling      | Tailwind CSS                                               |
| Server state | TanStack Query v5                                          |
| Client state | Zustand                                                    |
| Wallet       | `@stellar/freighter-api`, `@lobstrco/signer-extension-api` |

## Component structure

The UI is intentionally minimal: one page, one panel.

```
App
├── Header
│   └── WalletConnect        # Connect / disconnect + wallet picker (#611)
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
              └─► signTransaction(xdr, networkPassphrase)  ← whichever wallet is selected
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

### WalletAdapter abstraction

Frontend code never talks to a wallet SDK directly. It depends on the `WalletAdapter` interface in `apps/web/src/lib/wallet.ts`, which every supported wallet implements:

```typescript
interface WalletAdapter {
  isInstalled(): Promise<boolean>;
  isAuthorized(): Promise<boolean>;
  connect(): Promise<string>;
  sign(xdr: string, networkPassphrase: string): Promise<string>;
}
```

### Wallet registry and picker (#611)

`wallet.ts` exports `WALLETS: WalletMeta[]`, one entry per implemented adapter (`FreighterWallet`, `LobstrWallet`; `XBullWallet` joins once #598 merges — nothing else here needs to change for that). Each entry carries an `id`, a display `name`, an `installUrl` for the no-extension fallback, and the adapter instance itself.

Which wallet is "selected" is tracked independently of `useWalletStore`, in `wallet.ts` itself (`getSelectedWalletId()`/`setSelectedWalletId()`, backed by a plain `localStorage` key) — not in the Zustand store, to avoid a circular import (`store/wallet.ts` already imports from `lib/wallet.ts`). It defaults to Freighter and only changes on a _successful_ connect, so a failed or cancelled attempt never silently switches which wallet later sign/reconnect calls go through.

`useWalletConnect().handleConnect(walletId?)` connects through a specific wallet — passed explicitly by the picker UI in `WalletConnect.tsx`, or defaulted to the persisted selection when omitted (the plain "Connect Wallet" button's click handler, unchanged from before the picker existed). `attemptedWalletId` (also returned by the hook) tracks whichever wallet the most recent attempt was for, so the `status === "no-extension"` fallback can link to that wallet's own `installUrl` and name instead of a hardcoded Freighter link.

The exported `wallet: WalletAdapter` singleton still exists for callers that only care about "whichever wallet the user is connected through" — `useSignAndSubmit`'s `sign()` call and the store's `revalidate()`'s `isAuthorized()` check — and now dispatches to `getWalletAdapter(getSelectedWalletId())` on every call rather than being pinned to Freighter. Adding a new wallet still means adding a `WalletAdapter` implementation and one entry in `WALLETS`; no caller of the singleton or of `useWalletConnect` needs to change.

## API client

`apps/web/src/lib/api.ts` exports a typed `api` object wrapping `fetch`. All requests go to `${VITE_API_URL}/api/v1/...`. In local dev `VITE_API_URL` is empty and Vite proxies `/api` to `http://localhost:3001`. In production it is also empty and requests hit the same Vercel origin where the serverless functions live.

Error handling in `apiFetch` normalises error bodies from multiple shapes (Fastify, Vercel, nested objects) into a single string, with `Request failed (${status})` as the fallback for HTTP/2 responses where `statusText` is empty.
