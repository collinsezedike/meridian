# Transaction signing flow

Meridian's core security property is simple: **the API never holds or sees a private key.**
It builds an _unsigned_ Soroban transaction, returns it as a base64 XDR string, and the
browser hands that XDR to the user's connected wallet for signing, via the `WalletAdapter`
interface (`isInstalled` / `isAuthorized` / `connect` / `sign`) described below. The signed
XDR is then relayed back through the API only to be forwarded to the Stellar network — the
API still never signs anything itself.

This document is the reference for how the XDR builder and the wallet adapter fit together.
Implement against this doc; you should not need to read the Soroban auth docs to get the flow
right.

## Sequence

```mermaid
sequenceDiagram
    actor User
    participant Browser as Browser (React app)
    participant API as Meridian API (/api/v1/tx)
    participant Wallet as Connected wallet (WalletAdapter)
    participant RPC as Stellar Soroban RPC

    User->>Browser: Click "Deposit 100 USDC"
    Browser->>API: POST /api/v1/tx/deposit { walletAddress, vaultId, amount }
    API->>RPC: simulateTransaction (estimate fee + footprint)
    RPC-->>API: simulation result (minResourceFee)
    API-->>Browser: { xdr, fee }  ← UNSIGNED, no signatures attached

    Browser->>Wallet: wallet.sign(xdr, networkPassphrase)
    Note over Wallet: User reviews & approves.<br/>Private key never leaves the wallet.
    Wallet-->>Browser: signedTxXdr

    Browser->>API: POST /api/v1/tx/submit { xdr: signedTxXdr }
    API->>RPC: sendTransaction(signedTxXdr)
    RPC-->>API: { hash, status }
    API-->>Browser: { hash }
    Browser-->>User: Toast: "Deposited 100 USDC"
```

## Why the API returns only an unsigned XDR

- **No custody, no liability.** The API has no access to a signing key, so a compromised API
  server cannot move user funds. The worst a malicious/compromised build endpoint can do is
  return a transaction the user can inspect and reject in their wallet.
- **The wallet is the trust boundary.** The connected wallet shows the user the operations and
  asset amounts before they approve. Signing happens inside the wallet (e.g. a browser
  extension); the decrypted key never enters the page or the network.
- **The `/submit` endpoint only relays.** It accepts an _already-signed_ XDR and forwards it to
  Soroban RPC via `sendTransaction`. It does not (and cannot) add signatures. Submitting could
  also be done straight from the browser to RPC; routing it through the API just centralises
  endpoint configuration and error handling.

## Endpoint reference

All bodies are JSON. `walletAddress` is a 56-character Stellar public key (`G...`).
Amounts (`amount`, `shares`) are decimal strings with up to 7 fractional digits
(e.g. `"100"`, `"12.5000000"`) — never numbers, to avoid float precision loss.

### `POST /api/v1/tx/deposit`

Builds an unsigned deposit transaction. Asserts the wallet holds the required USDC/mUSDC
trustlines first; if not, it throws and the frontend prompts the user to add them via
`POST /api/v1/tx/add-trustline`.

Request:

```json
{
  "walletAddress": "GABC...XYZ",
  "vaultId": "blend-usdc",
  "amount": "100"
}
```

Response `200`:

```json
{
  "xdr": "AAAAAg...base64-unsigned-envelope...",
  "fee": "10732"
}
```

- `xdr` — base64 transaction envelope, **unsigned**, already prepared via
  `assembleTransaction` (Soroban footprint + resource fee included).
- `fee` — the simulated `minResourceFee` in stroops, for display.

### `POST /api/v1/tx/withdraw`

Builds an unsigned withdraw transaction. `shares` is the amount of vault share token (mUSDC)
to redeem.

Request:

```json
{
  "walletAddress": "GABC...XYZ",
  "vaultId": "blend-usdc",
  "shares": "50"
}
```

Response `200`: same shape as deposit — `{ "xdr": "...", "fee": "..." }`.

### Error responses

Both endpoints return `400` with `{ "error": "<message>" }` for validation failures
(bad public key, malformed amount, missing fields), and `500` with the
simulation/build error message for anything else that throws — including a vault whose
contract address is not configured, which surfaces as
`Vault not configured: <vaultId>. Add it to KNOWN_POOLS with a contractId.`
There is no `503` on these two endpoints: `handleDepositRequest`/`handleWithdrawRequest`
in [`packages/api-core/src/tx.ts`](../packages/api-core/src/tx.ts) wrap the whole build
call in one `try/catch` that always answers `500`.

## What the frontend must do between receiving the XDR and submitting

1. **Resolve the network passphrase** for the active network
   (`"Test SDF Network ; September 2015"` for testnet,
   `"Public Global Stellar Network ; September 2015"` for mainnet). This must match the network
   the XDR was built for, or the wallet will produce an invalid signature.
2. **Sign** by calling `wallet.sign(xdr, networkPassphrase)` on the connected `WalletAdapter`
   (see [`apps/web/src/lib/wallet.ts`](../apps/web/src/lib/wallet.ts)). Each adapter implements
   this against the underlying wallet's own API and normalizes the result to a signed XDR
   string; the caller doesn't need to know which wallet is behind it. The user rejecting the
   signing prompt is a normal, non-fatal outcome — adapters and callers swallow cancel/reject
   errors rather than surfacing them.
3. **Submit** the signed XDR via `POST /api/v1/tx/submit` with body `{ "xdr": signedTxXdr }`.
   The response is `{ "hash": "<tx-hash>" }`.
4. **Refresh state** — invalidate the user's `["positions", publicKey]` query so the new
   balance is reflected, and surface success/error to the user.

## The WalletAdapter interface

Frontend code never talks to a wallet's own SDK directly — it depends on a common
`WalletAdapter` interface (defined in
[`apps/web/src/lib/wallet.ts`](../apps/web/src/lib/wallet.ts)) that every supported wallet
implements:

```typescript
interface WalletAdapter {
  isInstalled(): Promise<boolean>;
  isAuthorized(): Promise<boolean>; // has the user granted this site access?
  connect(): Promise<string>; // resolves the connected public key
  sign(xdr: string, networkPassphrase: string): Promise<string>; // resolves the signed XDR
}
```

`useWalletConnect` calls `wallet.isInstalled()` to detect the wallet and `wallet.connect()` to
request access; `useWalletStore` calls `wallet.isAuthorized()` on mount and on window focus to
re-validate a persisted key, clearing it if the wallet is gone or access was revoked. Signing a
transaction (this doc's flow) goes through `wallet.sign()`.

Today two adapters exist in code, `FreighterWallet` and `LobstrWallet`, but only Freighter is
currently wired up as the active `wallet` export — there is no wallet-selection UI yet, so
LOBSTR's adapter isn't reachable from the app.

<!-- TODO(#613): describe picker UI once #476/#488/#490 land -->

The examples in this doc use Freighter as the concrete illustration since it's the wallet
actually in use today, but nothing in the flow is Freighter-specific — any `WalletAdapter`
implementation follows the same sequence.

The browser-side wrappers live in
[`apps/web/src/lib/wallet.ts`](../apps/web/src/lib/wallet.ts) (signing) and
[`apps/web/src/lib/api.ts`](../apps/web/src/lib/api.ts) (build/submit calls); the orchestration
is in [`apps/web/src/hooks/useVaultActions.ts`](../apps/web/src/hooks/useVaultActions.ts).
