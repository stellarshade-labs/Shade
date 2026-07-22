# @shade/crypto

Pure TypeScript implementation of stealth addresses for Stellar using DKSAP (Dual-Key Stealth Address Protocol) on ed25519.

This is the SDK core: the cryptographic primitives the rest of the monorepo
builds on. It has **zero dependency on `@stellar/stellar-sdk`**:
all elliptic-curve math runs through [`@noble/curves`](https://github.com/paulmillr/noble-curves)
and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes), which are the
same audited primitives used across the Stellar ecosystem. Correctness, a stable
public API, and a clearly-scoped security model are the priorities here.

> **Security status:** the protocol and this implementation have **not yet
> undergone external cryptographic audit**. Treat the library as production-track
> but pre-audit; see [Roadmap & Audit Status](#roadmap--audit-status) before
> handling mainnet value.

## Installation

**This package is not published to npm.** It is a workspace-internal package,
bundled into the published SDK at build time, so installing the SDK gives you
this code without a second dependency:

```bash
npm install stellar-shade
```

Everything below documents the primitives as they exist inside this repo. Note
that the SDK re-exports only a small surface of them (see
[SDK Reference](../../docs/07-sdk-reference.md)); to use the full API directly,
work inside the monorepo, where workspaces resolve `@shade/crypto` for you.

## Quick Start

```typescript
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddress,
  scanAnnouncements,
  recoverStealthPrivateKey,
} from '@shade/crypto';

// 1. Generate a stealth meta-address (receiver)
const receiver = generateMetaAddress();
const encodedMeta = encodeMetaAddress(receiver.metaAddress);
console.log('Share this meta-address:', encodedMeta);
// Output: shade:stellar:abc123...def456

// 2. Derive a stealth address (sender)
const stealth = deriveStealthAddress(receiver.metaAddress);
console.log('Send XLM to:', stealth.stealthAddress);
// Output: GABC...XYZ (normal Stellar address)

// 3. Scan for your stealth addresses (receiver)
const announcements = [{
  ephemeralPubKey: stealth.ephemeralPubKey,
  viewTag: stealth.viewTag,
  stealthAddress: stealth.stealthAddress
}];

const found = scanAnnouncements(
  receiver.viewPrivKey,
  receiver.metaAddress.spendPubKey,
  announcements
);
console.log('Found stealth addresses:', found);

// 4. Recover private key to withdraw (receiver)
const stealthKey = recoverStealthPrivateKey(
  receiver.spendPrivKey,
  receiver.viewPrivKey,
  stealth.ephemeralPubKey
); // StealthScalar wrapper (NOT a raw Uint8Array)

// Sign directly on the wrapper. Because StealthScalar is not a Uint8Array,
// `Keypair.fromRawEd25519Seed(stealthKey)` is a COMPILE ERROR — the fund-loss
// footgun (a seed API hashing the raw scalar to a mismatched key) is gone.
const signature = stealthKey.sign(withdrawMessage);
stealthKey.zeroize(); // clear the key from memory when done
```

## DKSAP Protocol

The Dual-Key Stealth Address Protocol (DKSAP) provides unlinkable payment addresses on Stellar using ed25519 elliptic curve cryptography.

### Mathematical Foundation

**Meta-Address Generation:**
- Generate two random scalars: `k_spend`, `k_view` ∈ [0, L-1]
- Compute public keys: `K_spend = k_spend × G`, `K_view = k_view × G`
- Meta-address: `(K_spend, K_view)`

**Stealth Address Derivation (Sender):**
1. Pick random ephemeral scalar: `r ∈ [0, L-1]`
2. Compute ephemeral public key: `R = r × G`
3. Compute shared secret: `S = r × K_view`
4. Hash to scalar: `s = SHA256(S) mod L`
5. Derive stealth public key: `P_stealth = K_spend + s × G`
6. Extract view tag: `view_tag = SHA256(S)[0]` (first byte for fast scanning)

**Scanning (Receiver):**
1. For each announcement, compute: `S = k_view × R`
2. Quick filter: check if `SHA256(S)[0] == view_tag`
3. If match, derive: `P_stealth = K_spend + SHA256(S) × G`
4. Verify the stealth address matches

**Private Key Recovery (Receiver):**
1. Compute shared secret: `S = k_view × R`
2. Hash to scalar: `s = SHA256(S) mod L`
3. Recover private key: `p_stealth = k_spend + s mod L`

**Curve Parameters:**
- Curve: ed25519
- Generator: Standard ed25519 base point G
- Order: L = 2^252 + 27742317777372353535851937790883648493

### Security Properties

- **Unlinkability:** Given multiple stealth addresses, it's computationally infeasible to determine if they belong to the same meta-address
- **Non-reusability:** Each stealth address is unique due to random ephemeral key generation
- **View-only scanning:** The view key allows scanning for incoming payments without spending ability
- **Perfect forward secrecy:** Compromise of one stealth private key doesn't affect others

## API Reference

### Key Generation

#### `generateMetaAddress(): StealthKeys`

Generate a new stealth meta-address with random keys.

**Returns:** Complete stealth keys including:
- `spendPrivKey`: 32-byte spend private key
- `viewPrivKey`: 32-byte view private key
- `metaAddress`: Object containing public keys
  - `spendPubKey`: 32-byte spend public key
  - `viewPubKey`: 32-byte view public key

**Example:**
```typescript
const keys = generateMetaAddress();
// Share keys.metaAddress publicly
// Keep keys.spendPrivKey and keys.viewPrivKey secret
```

#### `encodeMetaAddress(meta: StealthMetaAddress): string`

Encode a stealth meta-address to a shareable string format with checksum.

**Parameters:**
- `meta`: Stealth meta-address containing spend and view public keys

**Returns:** Encoded string in format `shade:stellar:<hex><checksum>`

**Throws:** `InvalidMetaAddress` if keys are invalid or not on curve

**Example:**
```typescript
const encoded = encodeMetaAddress(keys.metaAddress);
// "shade:stellar:abc123...def456"
```

#### `decodeMetaAddress(encoded: string): StealthMetaAddress`

Decode a string-encoded stealth meta-address with checksum validation.

**Parameters:**
- `encoded`: Encoded meta-address string

**Returns:** Decoded stealth meta-address with public keys

**Throws:** `InvalidMetaAddress` if format, checksum, or keys are invalid

**Example:**
```typescript
const meta = decodeMetaAddress("shade:stellar:abc123...def456");
```

### Stealth Address Derivation

#### `deriveStealthAddress(metaAddr: StealthMetaAddress): StealthDerivation`

Derive a stealth address from a meta-address (sender side).

**Parameters:**
- `metaAddr`: Receiver's stealth meta-address

**Returns:** Derivation result containing:
- `stealthPubKey`: 32-byte stealth public key
- `stealthAddress`: Stellar address (G... format)
- `ephemeralPubKey`: 32-byte ephemeral public key for announcement
- `viewTag`: Single byte for fast scanning
- `ephemeralPrivKey`: 32-byte ephemeral private key (keep private)

**Throws:** `InvalidPublicKey` if meta-address keys are invalid

**Example:**
```typescript
const stealth = deriveStealthAddress(receiverMeta);
// Send XLM to stealth.stealthAddress
// Publish: ephemeralPubKey, viewTag, stealthAddress
```

### Scanning

#### `scanAnnouncements(viewPrivKey: Uint8Array, spendPubKey: Uint8Array, announcements: Announcement[]): StealthAddress[]`

Scan announcements to find stealth addresses belonging to the receiver.

Uses optimized two-pass algorithm:
- Pass 1: Filter by view tag (2x faster)
- Pass 2: Full verification only on matches

**Parameters:**
- `viewPrivKey`: Receiver's 32-byte view private key
- `spendPubKey`: Receiver's 32-byte spend public key
- `announcements`: Array of announcements to scan

**Returns:** Array of stealth addresses belonging to receiver

**Example:**
```typescript
const myAddresses = scanAnnouncements(
  viewPrivKey,
  spendPubKey,
  announcements
);
```

#### `checkViewTag(viewPrivKey: Uint8Array, ephemeralPubKey: Uint8Array, expectedTag: number): { matches: boolean; sharedSecret?: Uint8Array }`

Fast pre-filter check before expensive EC operations. Returns the shared secret on match so callers can reuse it without recomputing the ECDH.

**Parameters:**
- `viewPrivKey`: Receiver's view private key
- `ephemeralPubKey`: Ephemeral public key from announcement
- `expectedTag`: Expected view tag (0-255)

**Returns:** Object with `matches` boolean and optional `sharedSecret` (32 bytes, present only when `matches` is true)

#### `isMyStealthAddress(viewPrivKey: Uint8Array, spendPubKey: Uint8Array, ephemeralPubKey: Uint8Array, stealthAddress: string): boolean`

Check if a specific stealth address belongs to the receiver.

**Parameters:**
- `viewPrivKey`: Receiver's view private key
- `spendPubKey`: Receiver's spend public key
- `ephemeralPubKey`: Ephemeral public key from announcement
- `stealthAddress`: Stellar address to check

**Returns:** `true` if address belongs to receiver

### Private Key Recovery

#### `recoverStealthPrivateKey(spendPrivKey: Uint8Array, viewPrivKey: Uint8Array, ephemeralPubKey: Uint8Array): StealthScalar`

Recover the stealth private key for withdrawing funds.

**Parameters:**
- `spendPrivKey`: Receiver's 32-byte spend private key
- `viewPrivKey`: Receiver's 32-byte view private key
- `ephemeralPubKey`: 32-byte ephemeral public key from announcement

**Returns:** A **`StealthScalar` wrapper** around the recovered raw ed25519 scalar
(`k_spend + s mod L`). Sign with `.sign(message)`, get the stealth pubkey for
verification with `.publicKey()`, and clear it with `.zeroize()` when done
(replaces the old `key.fill(0)`).

> **WHY A WRAPPER (this is what removes a fund-loss footgun):** the recovered
> value is a raw ed25519 SCALAR, **not** an ed25519 seed. Seed-based Keypair APIs
> (`Keypair.fromRawEd25519Seed()`, `ed25519.sign()`, wallet imports) HASH their
> input into a *different* signing scalar whose public key does not match the
> stealth address; the contract rejects the signature and the funds become
> permanently unwithdrawable. Because `StealthScalar` is **not** a `Uint8Array`,
> `Keypair.fromRawEd25519Seed(key)` is now a **compile error** rather than silent
> fund loss.

**Example:**
```typescript
const stealthKey = recoverStealthPrivateKey(
  spendPrivKey,
  viewPrivKey,
  ephemeralPubKey
);
// Sign the withdrawal message directly on the wrapper.
const signature = stealthKey.sign(withdrawMessage);
stealthKey.zeroize(); // clear the key from memory when done
```

**Deprecated raw-bytes escape hatches (interop only).**
`recoverStealthPrivateKeyBytes(...)` returns the pre-0.1.0 raw `Uint8Array`, and
`stealthKey.dangerouslyToRawBytes()` returns a copy of the raw scalar from the
wrapper. Both are `@deprecated` and carry the same warning: **never** feed those
bytes to `Keypair.fromRawEd25519Seed()` or any seed-based API.

### Wallet-Derived Keys (SEP-53)

Instead of storing a separate mnemonic, an app can derive a user's stealth keys
deterministically from a signature produced by their existing Stellar wallet.
The user signs one fixed message; the resulting 64-byte ed25519 signature seeds
the spend and view keypairs. Because RFC 8032 ed25519 signatures are
deterministic, the same wallet signing the same message always re-derives the
same stealth keys, with no extra secret to back up.

#### `buildKeyDerivationMessage(opts?: { network?: string; appId?: string }): string`

Build the exact, human-readable message a wallet signs to derive its stealth
keys. Pure string builder, no `@stellar/stellar-sdk` dependency.

**Parameters:**
- `opts.network`: Network label to bind keys to (default `'any'`)
- `opts.appId`: Application identifier to scope keys (default `'default'`)

**Returns:** A newline-separated message string.

**Exact message format** (`\n`-joined, no trailing newline):

```
stellar-shade-keys-v1
network:<network>
app:<appId>
WARNING: Signing this message derives your stealth keys. Only sign it in apps you trust.
```

The first line is the `KEY_DERIVATION_CONTEXT_V1` domain-separation constant
(`stellar-shade-keys-v1`) and is guaranteed stable for the v1 scheme.

#### `deriveKeysFromSignature(signature: Uint8Array): StealthKeys`

Derive stealth spend and view keys from a wallet's 64-byte ed25519 signature
over the derivation message. Uses domain-separated SHA-256 (`shade-spend` /
`shade-view` tags) to produce two independent scalars, mirroring the BIP-39
derivation in `hd.ts`.

**Parameters:**
- `signature`: A 64-byte ed25519 signature over the derivation message

**Returns:** `StealthKeys`, the same shape as `generateMetaAddress()`

**Throws:** `InvalidScalar` if the signature is not exactly 64 bytes or is all zeros

#### SEP-53 signing envelope (SDK/CLI)

Wallets don't sign the raw derivation message; they sign the SHA-256 of the
[SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md)
signed-message envelope. The SDK and CLI reproduce this envelope so that a real
wallet and the local CLI derive identical keys:

```typescript
import { buildKeyDerivationMessage, deriveKeysFromSignature } from '@shade/crypto';
import { sha256 } from '@noble/hashes/sha256';

const message = buildKeyDerivationMessage({ network: 'testnet', appId: 'my-app' });

// SEP-53 envelope: "Stellar Signed Message:\n" + message, then SHA-256
const envelope = new TextEncoder().encode('Stellar Signed Message:\n' + message);
const digest = sha256(envelope);

// Wallet signs the 32-byte digest with its ed25519 spend key
const signature = wallet.sign(digest); // 64 bytes

const keys = deriveKeysFromSignature(signature);
// keys.metaAddress is the receiver's public meta-address
```

#### Security model

- **Deterministic signatures are REQUIRED.** Derivation only works with an
  RFC 8032 / RFC 6979 deterministic signer. A wallet that randomizes signatures
  derives different keys on every call and breaks recovery. Do not use this with
  non-deterministic signers.
- **Wallet compromise EQUALS stealth key compromise.** Anyone who can produce
  this signature can re-derive (and therefore control) the stealth keys. This is
  a deliberate design trade-off: it buys keyless, recoverable-from-wallet stealth
  keys at the cost of binding stealth-key security to wallet security. Apps that
  need an independent trust boundary should use `generateMetaAddress()` or the
  BIP-39 derivation in `hd.ts` and back up the resulting keys separately.
- **Never sign the derivation message for any other purpose.** Signing it in an
  untrusted context hands over the ability to derive the keys. The `WARNING`
  line in the message makes this explicit to the signer.
- **`appId` scopes keys per app.** Different apps signing with the same wallet
  produce independent stealth keys, so a leak in one app does not expose
  another. The `network` label scopes keys per network in the same way.

### Stellar Key Conversion

#### `encodePublicKey(pubKey: Uint8Array): string`

Convert ed25519 public key to Stellar address.

**Parameters:**
- `pubKey`: 32-byte ed25519 public key

**Returns:** Stellar address in G... format

#### `decodePublicKey(address: string): Uint8Array`

Convert Stellar address to ed25519 public key.

**Parameters:**
- `address`: Stellar address (G... format)

**Returns:** 32-byte ed25519 public key

**Throws:** `Error` if the address format, version byte, or checksum is invalid

### Advanced Features

#### `proveOwnership(stealthPrivKey: StealthScalar | Uint8Array, challenge: Uint8Array): Uint8Array`

Prove ownership of a stealth address by signing a challenge with the recovered
stealth key. Uses raw-scalar ed25519 signing so the signature verifies against
the stealth public key (`scalar × G`).

**Parameters:**
- `stealthPrivKey`: The recovered stealth key (`StealthScalar`; passing raw 32-byte scalar bytes is deprecated)
- `challenge`: The challenge to sign (typically a nonce or timestamp)

**Returns:** The 64-byte ed25519 signature

#### `verifyOwnership(stealthPubKey: Uint8Array, challenge: Uint8Array, signature: Uint8Array): boolean`

Verify a stealth-address ownership proof: a standard ed25519 signature checked
against the stealth public key.

**Parameters:**
- `stealthPubKey`: The 32-byte stealth public key (`scalar × G`)
- `challenge`: The challenge that was signed
- `signature`: The 64-byte signature to verify

**Returns:** `true` if the signature is valid

## Security Considerations

### Private Key Management

- **Never log or transmit private keys** - Stealth private keys should only exist in memory during transaction signing
- **Use secure randomness** - All random values use `crypto.getRandomValues()` internally
- **Clear sensitive data** - Zero out private keys from memory after use

### Meta-Address Distribution

- Share meta-addresses through secure channels when privacy is critical
- Consider using separate meta-addresses for different contexts
- Meta-addresses are public but linkable to an identity if not careful

### View Key Delegation

- View keys can be shared with trusted scanning services
- View keys allow balance checking but not spending
- Compromised view keys reduce privacy but don't risk funds

### Ephemeral Key Storage

- Ephemeral public keys must be published for receivers to find payments
- Store ephemeral private keys securely if needed for auditing
- Consider pruning old announcements for privacy

## Type Definitions

```typescript
interface StealthMetaAddress {
  spendPubKey: Uint8Array;  // 32 bytes
  viewPubKey: Uint8Array;   // 32 bytes
}

interface StealthKeys {
  spendPrivKey: Uint8Array;           // 32 bytes
  viewPrivKey: Uint8Array;            // 32 bytes
  metaAddress: StealthMetaAddress;
}

interface StealthDerivation {
  stealthPubKey: Uint8Array;     // 32 bytes
  stealthAddress: string;        // G... format
  ephemeralPubKey: Uint8Array;   // 32 bytes
  viewTag: number;               // 0-255
  ephemeralPrivKey: Uint8Array;  // 32 bytes
}

interface Announcement {
  ephemeralPubKey: Uint8Array;  // 32 bytes
  viewTag: number;               // 0-255
  stealthAddress: string;        // G... format
}

interface StealthAddress {
  publicKey: Uint8Array;  // 32 bytes
  address: string;        // G... format
}
```

## Error Types

- `InvalidPublicKey` - Public key not on ed25519 curve
- `InvalidScalar` - Scalar not in valid range [0, L-1]
- `InvalidMetaAddress` - Invalid meta-address format or checksum
- `PointAtInfinity` - Invalid EC point operation result

## API Stability & Versioning

This package follows [Semantic Versioning](https://semver.org/). The public
surface is the set of functions and types exported from the package entrypoint
and documented in the [API Reference](#api-reference) above.

- **Wire and derivation formats are versioned.** The meta-address encoding
  (`shade:stellar:` prefix) and the wallet key-derivation scheme carry explicit
  version tags (e.g. `KEY_DERIVATION_CONTEXT_V1` / `stellar-shade-keys-v1`).
  Any change that would alter derived keys or on-the-wire encodings ships under a
  new version tag rather than silently mutating the existing one, so previously
  derived keys and published announcements remain valid.
- **Breaking changes only on major versions.** Signature or behavioural changes
  to an exported function are reserved for major releases and called out in the
  changelog.
- **Pre-1.0 caveat.** While the package is below `1.0.0`, minor versions may
  still refine the API. The DKSAP math and the v1 derivation/encoding formats
  are considered stable; ancillary helpers may evolve.
- **0.1.0 (breaking).** `recoverStealthPrivateKey` now returns a `StealthScalar`
  wrapper instead of a raw `Uint8Array`: sign with `.sign()`, verify with
  `.publicKey()`, clear with `.zeroize()`. This is a deliberate breaking change
  (A5): `Keypair.fromRawEd25519Seed(key)` no longer type-checks, removing a
  fund-loss footgun. Use the deprecated `recoverStealthPrivateKeyBytes()` if you
  genuinely need the old raw bytes.

## Roadmap & Audit Status

The items below are explicit, tracked limitations, not accepted shortcuts. They
represent the gap between "production-track" and "audited for mainnet value."

- **External cryptographic audit (pending).** The DKSAP construction here follows
  the well-studied dual-key stealth-address design, but this specific
  implementation has not been independently audited. An external review of the
  scalar handling, ECDH, and key-derivation paths is required before we recommend
  mainnet use. Until then, prefer local/testnet and treat mainnet as out of scope.
- **Constant-time guarantees.** Secret-dependent operations rely on the
  constant-time properties of `@noble/curves`. Formalising and testing the
  end-to-end timing behaviour of the SDK's own code paths is a roadmap item.
- **Memory hygiene.** `recoverStealthPrivateKey` now returns a `StealthScalar`
  wrapper with a first-class `.zeroize()` method; call it when done. Extending
  the same opt-in zeroization to the remaining raw-`Uint8Array` key paths is a
  roadmap item.

Where this document notes a limitation, it is a roadmap commitment to close it,
not a permission to ship it unfixed.

## Links

- [Contracts](../../contracts/) - Soroban smart contracts for on-chain registry
- [CLI](../cli/) - Command-line interface for developers
- [Relayer](../relayer/) - HTTP service for sponsored transactions

## License

Apache License 2.0. See the repository root [LICENSE](../../LICENSE).