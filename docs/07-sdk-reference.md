---
title: SDK Reference
description: "The @shade/sdk and @shade/crypto API: StealthClient, types, typed errors, Freighter signing, encrypted sessions and the stealth-address primitives."
---

# Shade SDK Reference

Two packages ship for application developers:

- **`@shade/crypto`** — pure stealth-address math (keys, scanning, recovery, HD/mnemonic). **Zero** Stellar dependency; usable anywhere.
- **`@shade/sdk`** — the batteries-included client. Wraps all Horizon/Soroban I/O behind `StealthClient`, so you never touch DKSAP math or transaction XDR.

Every symbol on this page is exported from the package named in its heading.

---

## Quick start

```typescript
import { StealthClient } from '@shade/sdk';

const client = new StealthClient({
  network: 'testnet',
  contractId: 'C...',                 // required when the pool method is enabled
  methods: ['pool', 'account'],
  relayer: 'https://your-relayer.example', // optional
});

const bob = StealthClient.keygen();   // share bob.metaAddress ("shade:stellar:...")

await client.send(bob.metaAddress, 100, aliceSecret, { method: 'auto' });

const payments = await client.scan(bob);
await client.claim(payments[0], bobPublicKey, { keys: bob, feePayer: feePayerSecret });
```

---

## `StealthClient`

### Constructor

```typescript
new StealthClient(config: ClientConfig)
```

```typescript
interface ClientConfig {
  network: 'testnet';     // effectively 'testnet' only today; the NETWORKS table is mainnet-extensible post-audit
  contractId?: string;    // required whenever 'pool' is enabled (no built-in default now — pass your deployed pool id)
  horizonUrl?: string;    // override the Horizon endpoint (account method)
  methods?: DeliveryMethod[];  // default: ['pool']
  relayer?: string;       // default relayer URL for fee-bumped submissions
}
```

`network` resolves through a single `NETWORKS` table (`packages/sdk/src/soroban.ts`); adding a network there — e.g. mainnet (`public`) after the audit — widens the accepted type automatically. Today the only entry is `testnet`.

Throws **`ContractIdRequiredError`** if `'pool'` is enabled and no contract id resolves — failing loudly here instead of surfacing an opaque Soroban error on the first pool call.

### Static methods

```typescript
StealthClient.keygen(): StealthKeys
StealthClient.fromMnemonic(mnemonic?: string): StealthKeys & { mnemonic: string }
```

Both are offline — no network needed. `fromMnemonic()` generates a phrase when called with no argument and returns it alongside the keys for backup.

### `send`

```typescript
send(
  metaAddress: string,
  amount: number,
  senderSecret: string,
  opts?: SendOpts,
): Promise<SendReceipt>
```

A method is **required** on every call. Throws `MethodRequiredError` if `opts.method` is missing, `MethodNotEnabledError` if the resolved method isn't in `config.methods`.

With an external signer, pass the sender's **public** `G...` address in the `senderSecret` position.

### `scan` / `scanWithCursor`

```typescript
scan(keys: StealthKeys): Promise<Payment[]>
scanWithCursor(keys: StealthKeys, opts?: ScanOpts): Promise<ScanResult>
```

`scan` is the simple form. `scanWithCursor` returns an updated per-method cursor to persist and pass to the next call for incremental discovery.

### `balance`

```typescript
balance(keys: StealthKeys): Promise<Balance[]>
```

Like a scan, but suppresses fully-swept/merged native accounts (live balance 0) so a spent stealth account is never reported as spendable.

### `claim`

```typescript
claim(
  payment: Payment,
  destination: string,
  opts: ClaimOpts,
): Promise<ClaimReceipt>
```

Takes a `Payment` returned from `scan` and branches on its `method`: `'pool'` → signed withdraw; `'account'` → sweep / partial payout / sponsored claim.

### `withdraw` — deprecated

```typescript
withdraw(
  stealthAddress: string,
  destination: string,
  opts: WithdrawOpts,
): Promise<WithdrawReceipt>
```

> **Deprecated.** Use `claim()` with a pool payment. Retained for backwards compatibility; behaves exactly like the original pool withdraw. Requires the `'pool'` method to be enabled, else throws `MethodNotAvailableError`.

---

## Types (`@shade/sdk`)

```typescript
type DeliveryMethod = 'pool' | 'account' | 'spp';

interface StealthKeys {
  metaAddress: string;   // shade:stellar:... — share publicly
  spendPubKey: string;   // hex
  spendPrivKey: string;  // hex — NEVER share
  viewPubKey: string;    // hex
  viewPrivKey: string;   // hex — safe to share with scanning services
}

interface SendReceipt {
  stealthAddress: string;
  txHash: string;
}

interface Payment {
  stealthAddress: string;
  ephemeralPubKey: string;      // hex
  token: string;                // SAC contract address, or 'native'
  asset?: string;               // "CODE:ISSUER" / 'native' (account-method token payments)
  claimableBalanceId?: string;  // present => this is a token claim
  amount: number;               // whole units
  amountStroops?: string;       // exact stroop count — prefer this over `amount`
  method: DeliveryMethod;
  txHash?: string;
}

interface Balance {
  stealthAddress: string;
  token: string;
  amount: number;
  amountStroops?: string;
}

interface ClaimReceipt { txHash: string; amount: number; method: DeliveryMethod; }
interface WithdrawReceipt { txHash: string; amount: number; }

interface ScanCursor { pool?: string; account?: string; spp?: string; }
interface ScanOpts   { methods?: DeliveryMethod[]; cursor?: ScanCursor; }
interface ScanResult { payments: Payment[]; cursor: ScanCursor; }
```

> **Precision.** `amount` is a `number` for display and backwards compatibility. Above ~9.007e8 XLM a double cannot represent every stroop — use `amountStroops` whenever exactness matters. The SDK itself derives token payout strings from the exact stroop count, never the lossy double.

### `SendOpts`

```typescript
interface SendOpts {
  method: DeliveryMethod | 'auto';   // REQUIRED
  asset?: string;                    // "CODE:ISSUER"; default native XLM
  signTransaction?: TransactionSigner;
  feePayerAddress?: string;          // unused by send(); present for symmetry
}
```

### `ClaimOpts`

```typescript
interface ClaimOpts {
  keys: StealthKeys;          // required
  relay?: string;             // fee-bumped submission
  merge?: boolean;            // account method: sweep via AccountMerge (default true)
  feePayer?: string;          // pool method: secret paying the Soroban fee
  asset?: string;             // pool method
  amount?: number;            // partial claim
  sponsored?: boolean;        // account-method token claim via the relayer
  fundingAccount?: string;    // credit-gated relayer: account to debit
  signTransaction?: TransactionSigner;
  feePayerAddress?: string;   // required when signTransaction is set on a pool claim
}
```

---

## External signing (Freighter)

A web app should **never** hold a raw secret. Pass a signer function instead:

```typescript
type TransactionSigner = (
  xdr: string,
  opts: { networkPassphrase: string; address?: string },
) => Promise<string>;
```

```typescript
import freighterApi from '@stellar/freighter-api';

const signTransaction = async (xdr: string) => {
  const { signedTxXdr } = await freighterApi.signTransaction(xdr, { networkPassphrase });
  return signedTxXdr;
};

// Pass a G-address where a secret normally goes.
await client.send(bob.metaAddress, 100, alicePublicKey, {
  method: 'account',
  signTransaction,
});
```

**The security boundary:** the signer only ever applies to the **sender** and **fee-payer** legs — the ordinary Stellar signatures. The **stealth-key** legs always sign locally inside the SDK, because a wallet cannot hold a key it never generated. *Your wallet never touches the stealth scalar.*

On a pool claim with a signer you must also pass `feePayerAddress` (the fee payer's `G...`), or you get `FeePayerAddressRequiredError` — this prevents the SDK from ever calling `Keypair.fromSecret` on a public key.

---

## Wallet-derived keys

```typescript
import { keysFromWalletSignature, DEFAULT_KEY_SCOPE, DEFAULT_APP_ID } from '@shade/sdk';

const keys = await keysFromWalletSignature(
  (msg) => freighter.signMessage(msg),
  { appId: 'my-app' },
);
```

```typescript
interface WalletKeysOpts {
  keyScope?: string;            // default 'stealth' — decoupled from the transport network
  appId?: string;               // default 'default'
  verifyDeterminism?: boolean;  // default TRUE — signs twice and throws if they differ
}
```

Determinism is verified **by default**: a randomized or non-canonical signer would derive different (unrecoverable) keys on every call, so it fails loudly instead. Pass `verifyDeterminism: false` only for a signer you know is RFC 8032 deterministic.

`keyScope` / `appId` must **match across every tool** deriving from the same wallet. The defaults line up with the CLI's `--key-scope` / `--app-id`.

---

## Sessions (`StealthSession`)

Cookie-free browser sessions over any key/value store:

```typescript
import { StealthSession } from '@shade/sdk';

const session = new StealthSession({ storage: window.localStorage });
await session.saveKeys(keys, password);
// ... later ...
await session.unlock(password);
const keys = session.keys;
```

```typescript
interface KVStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}
```

Methods: `saveKeys`, `unlock`, `lock`, `hasKeys`, `clear`, `loadScanState`, `saveScanState`; getter `keys`.

**Crypto:** PBKDF2-SHA256 (600,000 iterations) → AES-256-GCM, via `globalThis.crypto.subtle` only (browsers and Node 18+). Public keys are stored in the clear; private keys and scan state are encrypted. This is intentionally separate from the CLI keystore (which uses Node's scrypt).

**Integrity:** on `unlock`, both public keys are re-derived from the decrypted private scalars and compared to the stored cleartext pubkeys — a storage-write attacker cannot swap in a wrong pubkey and silently break scanning. Mismatch throws `SessionIntegrityError`; a bad password throws `WrongPasswordError`.

---

## `RelayerClient`

```typescript
import { RelayerClient } from '@shade/sdk';

const relayer = new RelayerClient('http://localhost:3000');
const { status } = await relayer.health();
```

| Method | Purpose |
|---|---|
| `health()` | Status, balance, address |
| `relay(xdr, opts?)` | Fee-bump and submit a signed envelope |
| `sponsor(address, opts?)` | Create a stealth account from the relayer's balance |
| `sponsorClaimPrepare(args)` | Build the sponsored claim tx (returns unsigned XDR) |
| `sponsorClaimSubmit(xdr, args)` | Co-sign + submit a sponsored claim |
| `creditClaim(fundingAccount, txHash)` | Top up credit by proving an XLM payment |
| `creditBalance(fundingAccount)` | Read a credit balance |

Also exported: `challengeMessage(endpoint, fundingAccount, nonce, amount, bind?)` — the canonical proof-of-control message, which must match the relayer byte-for-byte. See [Relayer](./08-relayer.md).

---

## Typed errors

All exported from `@shade/sdk` so apps can branch cleanly. Every error extends a shared **`ShadeError`** base and carries a stable **`code`** string (e.g. `method_required`, `transaction_timeout`) — branch on `e.code` when `instanceof` is unreliable across bundling/realm boundaries:

```typescript
import { MethodRequiredError, ContractIdRequiredError, NoBalanceError,
         AnnouncementNotFoundError, StealthAccountNotFoundError,
         DestinationTrustlineError, FeePayerRequiredError,
         TransactionTimeoutError, ClaimAmountRequiresNoMergeError,
         SponsoredClaimMismatchError, ShadeError } from '@shade/sdk';

try {
  await client.claim(payment, dest, { keys });
} catch (e) {
  if (e instanceof DestinationTrustlineError) { /* add a trustline first */ }
}
```

| Error | Thrown when |
|---|---|
| `MethodRequiredError` | `send()` called without `opts.method` |
| `MethodNotEnabledError` | Requested method isn't in `config.methods` |
| `MethodNotAvailableError` | Method exists but can't service the request (e.g. `spp`) |
| `MinimumAmountError` | Account-method XLM send ≤ 1 XLM |
| `ClaimAmountError` | Partial account claim exceeds the max (carries `.max`) |
| `InvalidAmountError` | Amount isn't a positive finite number |
| `SponsoredClaimMismatchError` | Relayer-prepared XDR doesn't match your own inputs — **refuses to sign** |
| `WrongPasswordError` | Session decryption failed |
| `SessionIntegrityError` | Stored pubkey ≠ pubkey derived from decrypted private key |
| `NoBalanceError` | Pool address holds nothing for that asset |
| `AnnouncementNotFoundError` | No announcement matches these keys |
| `StealthAccountNotFoundError` | Stealth account missing on Horizon (send not confirmed?) |
| `DestinationTrustlineError` | Destination doesn't trust the asset |
| `FeePayerRequiredError` | Pool withdraw with no fee-payer secret (non-signer path) |
| `FeePayerAddressRequiredError` | `signTransaction` set on a pool claim without `feePayerAddress` |
| `EntryArchivedRestoringError` | Entry archived and the automatic restore failed (funds safe; retry) |
| `TransactionRetryableError` | RPC returned a non-terminal status — nothing landed, safe to retry (has `.retryable`) |
| `TransactionTimeoutError` | Submission stayed PENDING past the timeout — carries `.txHash` and `.retryable = false`; the tx **may still land**, so poll the hash, do NOT blindly resubmit |
| `ClaimAmountRequiresNoMergeError` | `claim({ amount })` given with an effective merge (account native) or on a token claim — refuses rather than silently sweeping the full balance |

---

## Helpers

```typescript
import { parseStroops, numberToStroops, formatStroops,
         labelForToken, resolveTokenAddress,
         prepareWithRestore, HorizonClient,
         PoolAdapter, AccountAdapter, SppAdapter } from '@shade/sdk';
```

| Helper | Purpose |
|---|---|
| `parseStroops(s)` / `numberToStroops(n)` / `formatStroops(b)` | Exact stroop conversion (no float drift) |
| `resolveTokenAddress(asset, passphrase)` | `'native'` / `'CODE:ISSUER'` → SAC contract address |
| `labelForToken(address, passphrase)` | Native SAC address → `'XLM'`; otherwise unchanged |
| `prepareWithRestore(...)` | Restore-aware Soroban prepare (see [Architecture](./03-architecture.md)) |
| `HorizonClient` | Injectable-fetch Horizon wrapper (testable offline) |
| `PoolAdapter` / `AccountAdapter` / `SppAdapter` | The delivery adapters, if you need them directly |

---

## `@shade/crypto`

The primitives, if you're not using the SDK:

```typescript
import {
  generateMetaAddress, encodeMetaAddress, decodeMetaAddress,
  deriveStealthAddress, computeStealthAddress, deriveStealthAddressWithSecret,
  scanAnnouncements, checkViewTag, isMyStealthAddress,
  recoverStealthPrivateKey, signWithStealthKey, proveOwnership, verifyOwnership,
  encodePublicKey, decodePublicKey,
  generateMnemonic, validateMnemonic, mnemonicToStealthKeys,
  buildKeyDerivationMessage, deriveKeysFromSignature, KEY_DERIVATION_CONTEXT_V1,
  encryptAmount, decryptAmount,
  L, validatePoint, pointAdd, scalarMult, scalarMultBase, scalarAdd,
  generateRandomScalar, hashToScalar, viewTag,
} from '@shade/crypto';
```

### Types

All six exported types work in **raw bytes** (`Uint8Array`), not hex strings:

```typescript
/** The public halves of both keys — what a meta-address encodes. */
interface StealthMetaAddress {
  spendPubKey: Uint8Array;   // 32 bytes
  viewPubKey: Uint8Array;    // 32 bytes
}

/** A complete key set. NOTE: this is NOT the SDK's StealthKeys — see the warning below. */
interface StealthKeys {
  spendPrivKey: Uint8Array;  // 32 bytes
  viewPrivKey: Uint8Array;   // 32 bytes
  metaAddress: StealthMetaAddress;
}

/** One on-chain announcement, as scanning consumes it. */
interface Announcement {
  ephemeralPubKey: Uint8Array;  // 32-byte R = r·G
  viewTag: number;              // single byte, 0–255
  stealthAddress: string;       // G... StrKey
  txHash?: string;              // optional
}

/** A stealth address that scanning matched to you. */
interface StealthAddress {
  publicKey: Uint8Array;   // 32 bytes
  address: string;         // G... StrKey
}

/** What the sender gets from deriveStealthAddress / computeStealthAddress. */
interface StealthDerivation {
  stealthPubKey: Uint8Array;    // 32-byte P
  stealthAddress: string;       // G... StrKey
  ephemeralPubKey: Uint8Array;  // 32-byte R — publish this
  viewTag: number;              // publish this
  ephemeralPrivKey: Uint8Array; // 32-byte r — sender's records only, never publish
}

/** deriveStealthAddressWithSecret additionally exposes the ECDH secret. */
interface StealthDerivationWithSecret extends StealthDerivation {
  sharedSecret: Uint8Array;     // 32-byte S — feeds encryptAmount/decryptAmount
}
```

> **⚠️ Two different `StealthKeys`.** `@shade/crypto` and `@shade/sdk` both export a type named `StealthKeys`, and they are **not** the same shape:
>
> | | `@shade/crypto` | `@shade/sdk` |
> |---|---|---|
> | Encoding | `Uint8Array` (raw bytes) | `string` (hex) |
> | Fields | `spendPrivKey`, `viewPrivKey`, `metaAddress` (an object) | `metaAddress` (a `shade:stellar:` string), `spendPubKey`, `spendPrivKey`, `viewPubKey`, `viewPrivKey` |
>
> `StealthClient.keygen()` returns the **SDK** shape; `generateMetaAddress()` returns the **crypto** shape. Passing one where the other is expected will not type-check. Convert the crypto shape with the exported **`stealthKeysFromRaw(raw)`** helper, and import the crypto type under a distinct name via the re-export **`RawStealthKeys`**, so mixed-use code has one unambiguous import site.

Errors: `InvalidPublicKey`, `InvalidScalar`, `InvalidMetaAddress`, `PointAtInfinity`.

> **Critical.** `recoverStealthPrivateKey` returns a **`StealthScalar` wrapper**, not a raw `Uint8Array`. Sign directly on it — `key.sign(message)` — verify with `key.publicKey()`, and `key.zeroize()` when done. Because the wrapper is not a `Uint8Array`, `Keypair.fromRawEd25519Seed(key)` is a **compile error**, so the old fund-loss footgun (feeding the raw scalar to a seed API, which hashes to a mismatched key) can't happen. The deprecated `recoverStealthPrivateKeyBytes()` still returns the old raw bytes for interop; `dangerouslyToRawBytes()` on the wrapper does the same — both carry the same seed-API warning. See [Core Concepts](./02-core-concepts.md#the-math).

---

## Next steps

- [Core Concepts](./02-core-concepts.md) — the math behind these functions
- [Delivery Methods](./04-delivery-methods.md) — what `method` changes
- [Relayer](./08-relayer.md) — the service `RelayerClient` talks to
- [FAQ & Troubleshooting](./10-faq-troubleshooting.md) — error-by-error fixes
