---
title: Core Concepts
description: "How stealth addresses work on Stellar: DKSAP, view and spend keys, meta-addresses, view tags, and the ed25519 math behind them."
---

# Core Concepts: Stealth Addresses & DKSAP

Shade implements **DKSAP** (the Dual-Key Stealth Address Protocol) on ed25519. This page defines every term used across the rest of the docs, in plain English first, with the exact math underneath.

---

## Two keys, not one

Most wallets have one key that does everything. Shade splits your identity into **two** key pairs, which is what makes safe scanning possible:

- **View key.** Lets someone *find* payments sent to you. It can **see** but **cannot spend**. Safe to hand to a phone, a server, or a watch-only scanning service.
- **Spend key.** Required to actually *move* the money. This one never leaves you.

Each key has a public and a private half:

- The **public** spend + view keys go *into the meta-address you give out*, so a sender can do the math to create your one-time address.
- The **private** spend + view keys stay *with you*: the private view key **detects** incoming payments, the private spend key **spends** them.

> **Security consequence.** Sharing your view key gives someone permanent visibility into all your incoming payments, past and future. There is **no view key revocation**: to stop a viewer you must generate new keys and publish a new meta-address. Old payments stay visible to the old viewer.

## Meta-address

Your **meta-address** is the public halves of both keys, bundled and encoded:

```text
shade:stellar:<hex(spend_pk || view_pk || checksum)>
```

It is **not a Stellar account**: you cannot send funds to it directly. It is only an input a sender uses to *compute* a one-time address. Share it freely: profile, DM, business card.

> **For developers.** `encodeMetaAddress` / `decodeMetaAddress` in `@shade/crypto`. Payload is 64 bytes (32-byte spend pubkey ‖ 32-byte view pubkey) plus a 4-byte checksum = `SHA256(payload)[28..32]`, hex-encoded (136 hex chars). Decoding validates the prefix, strict hex, the checksum, and that both points are on-curve **and torsion-free** (rejecting small-order/identity points).

## Stealth address

A **stealth address** is the one-time destination a sender derives from your meta-address. It's a normal Stellar `G...` address, but nobody can link it back to your meta-address without your view key.

In the `pool` method the stealth address is never a real Stellar account. It's a **key** the contract uses to track your balance. In the `account` method it *is* a real, funded one-time account. See [Delivery Methods](./04-delivery-methods.md).

## Ephemeral key (R) and shared secret (S)

For every payment, the sender picks a fresh random scalar `r` and publishes `R = r·G` (the **ephemeral public key**). Both sides can then compute the same **shared secret** without talking to each other:

- Sender: `S = r · K_view`
- Receiver: `S = k_view · R`

This is **ECDH** (Elliptic Curve Diffie-Hellman): both parties arrive at the same `S` without it ever crossing the wire. `S` is what makes the stealth address derivable by you and nobody else.

## View tag

The **view tag** is a single byte, `SHA256(S)[0]`, published alongside each announcement. It's a fast-path filter: if the tag doesn't match, the announcement definitely isn't yours and you can skip the rest of the check.

**What it saves.** For the ~255/256 of announcements that don't match, the view tag lets a scanner skip the extra address-derivation step and move straight to the next announcement.

> Only the `pool` method uses view tags. The `account` method matches on the derived destination address directly, which *is* the full verification.

## The math

**Meta-address generation (receiver)**
1. Generate two random scalars `k_spend`, `k_view` ∈ [0, L-1]
2. Compute `K_spend = k_spend · G`, `K_view = k_view · G`
3. Meta-address = `(K_spend, K_view)`

**Stealth address derivation (sender)**
1. Pick random ephemeral scalar `r`
2. `R = r · G`
3. `S = r · K_view`
4. `s = SHA256(S) mod L`
5. `P_stealth = K_spend + s · G`
6. `view_tag = SHA256(S)[0]`

**Scanning (receiver)**
1. For each announcement: `S = k_view · R`
2. Filter: does `SHA256(S)[0]` equal the published view tag?
3. On a match: `P = K_spend + SHA256(S)·G`
4. Verify `P` equals the announced stealth address

**Private key recovery (receiver)**
1. `S = k_view · R`
2. `s = SHA256(S) mod L`
3. `p_stealth = k_spend + s mod L`

**Curve parameters**
- Curve: ed25519
- Order: `L = 2^252 + 27742317777372353535851937790883648493`

> **For developers: a critical footgun.** `recoverStealthPrivateKey` returns a **raw ed25519 scalar** (`k_spend + s mod L`), *not* an ed25519 seed. You must sign with `signWithStealthKey` from `@shade/crypto`. Never build a keypair from it via `Keypair.fromRawEd25519Seed()` or any seed-based API: those **hash** the input to derive a different signing scalar, producing a key that does not match the stealth public key. The contract would reject the signature and the funds would be unspendable.

## Why the ECDH runs client-side

Stellar's smart-contract environment doesn't offer the specific curve operation the ECDH needs, so that math runs **on your device**, not on-chain. The contract never sees your keys; it only checks a signature.

> **For developers.** Soroban's host exposes cryptographic functions such as `ed25519_verify`, `sha256`, `secp256r1_verify`, and curve operations for **BLS12-381** (CAP-0059) and **BN254**, but there is **no Curve25519 scalar-multiplication host function**. The DKSAP ECDH therefore cannot run on-chain and is performed client-side in `@shade/crypto`. The contract only ever *verifies* an ed25519 signature, which the host does support.

## Getting your keys: four ways

1. **Random.** Fresh keys, back them up yourself.
2. **BIP-39 mnemonic.** 12 words you write down; recover on any device.
3. **HD derivation.** Deterministic, via domain-separated SHA-256.
4. **From your wallet's signature.** Sign one fixed message with your Stellar wallet and Shade derives your stealth keys from that signature. Same wallet + same scope → the same keys every time, so there is nothing extra to store or back up. This is the "keyless" path.

> **For developers.** `packages/crypto/src/{keys.ts, hd.ts, derive-signature.ts}`. Derivation uses domain-separated SHA-256 with the labels `shade-spend` and `shade-view`, **not** BIP-32/BIP-44 paths (those are defined over secp256k1). The signed message is built by `buildKeyDerivationMessage({ network, appId })` and carries the context string `stellar-shade-keys-v1` plus an explicit warning line. The wallet path uses the **SEP-53** ("Sign and Verify Messages") prefix convention `"Stellar Signed Message:\n"` prepended to the message before signing.

**Trade-off for method 4:** your wallet effectively *is* your stealth-key backup. If the wallet is compromised, so are the stealth keys. That is the accepted deal for keyless recovery. Also: never sign the derivation message anywhere you don't trust. Anyone who obtains that signature can derive (and thus control) your stealth keys.

**Key scoping.** The `appId` and `keyScope` are folded into the signed message, so different applications derive independent keys. They must **match across every tool** that derives from the same wallet, or you'll get different, non-interoperable keys. Defaults: `appId = 'default'`, `keyScope = 'stealth'` (SDK constants `DEFAULT_APP_ID` / `DEFAULT_KEY_SCOPE`; the CLI's `--app-id` / `--key-scope` default to the same values).

## Announcement

An **announcement** is the on-chain record that lets you discover a payment. In the `pool` method it's a contract storage entry created **atomically with the deposit**: no deposit, no announcement, which makes announcement spam impossible. It carries:

| Field | Meaning |
|---|---|
| `ephemeral_pk` | The 32-byte `R` |
| `view_tag` | The one-byte fast-path filter (stored as `u32`) |
| `stealth_pk` | The 32-byte derived stealth public key |
| `token` | The SAC token address that was deposited |
| `amount` | Amount deposited, in the token's smallest unit |
| `sequence` | Ledger sequence at deposit time |

In the `account` method there is no contract announcement: the ephemeral key `R` rides in the transaction's **`MemoHash`**, and discovery means paging Horizon.


---

## Next steps

- [Architecture](./03-architecture.md): how these concepts map onto components
- [Delivery Methods](./04-delivery-methods.md): where `pool` and `account` differ
- [SDK Reference](./07-sdk-reference.md): the functions that implement all of this
- [Security](./09-security.md): what the cryptography does and does not guarantee
