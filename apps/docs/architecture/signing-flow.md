# Signing Flow

Meridian's core security property is that the server never holds or touches private keys. The signing flow enforces this by splitting transaction construction and transaction signing into separate steps on separate systems.

## Sequence diagram

```
Browser                    API (Vercel)              Stellar RPC
   │                           │                          │
   │  POST /tx/deposit         │                          │
   │  { walletAddress,         │                          │
   │    vaultId, amount }      │                          │
   │──────────────────────────►│                          │
   │                           │  getAccount(address)     │
   │                           │─────────────────────────►│
   │                           │◄─────────────────────────│
   │                           │  simulateTransaction(tx) │
   │                           │─────────────────────────►│
   │                           │◄─────────────────────────│
   │                           │  assembleTransaction      │
   │◄──────────────────────────│  (add footprint + fee)   │
   │  { xdr, fee }             │                          │
   │                           │                          │
   │  signTransaction(xdr)     │                          │
   │──────────────┐            │                          │
   │  Freighter   │            │                          │
   │  shows user: │            │                          │
   │  contract,   │            │                          │
   │  function,   │            │                          │
   │  amount,     │            │                          │
   │  protocol    │            │                          │
   │◄─────────────┘            │                          │
   │  signedXdr                │                          │
   │                           │                          │
   │  POST /tx/submit          │                          │
   │  { xdr: signedXdr }       │                          │
   │──────────────────────────►│                          │
   │                           │  sendTransaction(tx)     │
   │                           │─────────────────────────►│
   │                           │◄─────────────────────────│
   │◄──────────────────────────│  { hash }                │
   │  { hash }                 │                          │
```

## Why this design

**The API receives only a public key, never a private key.** It uses the public key to fetch the account's sequence number from the Stellar RPC, which is needed to construct a valid transaction. The private key never leaves the user's device.

**The user sees the transaction before signing.** Freighter displays the contract address, function name, and all arguments including the routing protocol. The user can reject if anything looks wrong.

**The API cannot forge a transaction on the user's behalf.** `caller.require_auth()` in the Soroban contract ensures the transaction is only valid if it carries a valid signature from `caller`. The API cannot produce that signature.

## What the simulation step does

Before returning XDR to the client, the API simulates the transaction against the Soroban RPC node. Simulation:

1. Executes the transaction in a read-only context to determine what contract storage entries will be read and written (the _footprint_).
2. Calculates the resource fee required to cover CPU and storage access.
3. Returns a `readBytes`, `writeBytes`, and `minResourceFee` estimate.

`rpc.assembleTransaction` then attaches this footprint and fee to the transaction. Without simulation, the transaction would fail on-chain because Soroban requires the footprint to be declared in advance.

## Network passphrase

Every Stellar transaction is bound to a specific network by its passphrase. The signed XDR from Freighter is only valid on the network it was signed for:

- Testnet: `Test SDF Network ; September 2015`
- Mainnet: `Public Global Stellar Network ; September 2015`

The API and Freighter must agree on the passphrase. Mismatches cause signature verification to fail at submission time.
