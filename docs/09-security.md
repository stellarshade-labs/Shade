---
title: Security
description: "Shade's threat model: what stealth addresses protect, what they explicitly do not hide, key-management assumptions, audit status and known limitations."
---

# Security Model & Threat Model

What Shade protects, what it explicitly does not, and what you must not rely on yet. Read this page before putting value at risk.

---

## Status: pre-audit — not for mainnet

The protocol and this implementation have **not undergone an external cryptographic audit**. An audit is on the roadmap. Treat the library as production-track but pre-audit, and **do not handle mainnet value**.

Development and testing are **local-network only**. `testnet` is a supported configuration (network settings exist, and the relayer ships a Railway/testnet deploy guide), but the project has **never actually been deployed to or tested on testnet**: every end-to-end exercise runs on the Docker local network, no test connects to testnet, and there is no CI pipeline. Treat any testnet or mainnet use as unexercised.

## Threat model

### What Shade protects

| Property | How |
|---|---|
| **Recipient identity** | A stealth address is unlinkable to a meta-address without the view key. An observer sees `sender → contract` (pool) or `sender → one-time account` (account), plus `R` and `stealth_pk`, none of which reveal *you*. |
| **Unlinkability between payments** | Each payment uses a fresh random ephemeral `r`, so two stealth addresses for the same recipient look unrelated. |
| **Your funded accounts** | A relayer fee-bump means your own wallet never appears on the withdrawal. |
| **Spend/view separation** | The view key can find payments but never move them — safe to delegate to a scanner. |
| **Replay across deployments/networks** | The withdraw message binds the contract address **and** the network id, so a signature valid on one deployment is rejected on another. |
| **Replay of the same withdrawal** | A strictly-increasing per-key nonce in contract storage. |
| **Reentrancy on withdraw** | Checks-effects-interactions: nonce and balance are committed before the external SAC `transfer`. |
| **Small-subgroup attacks** | `validatePoint` accepts only on-curve, **torsion-free** points, rejecting the identity and small-order points on every path that touches `R`, `K_view`, `K_spend`. |
| **Announcement spam** | Deposit and announcement are atomic — no deposit, no announcement. |
| **Malicious relayer (sponsored claim)** | The client re-derives the expected operation list from its own trusted inputs and refuses to sign a mismatch (`SponsoredClaimMismatchError`). |
| **Tampered session storage** | On unlock, public keys are re-derived from the decrypted private scalars and compared (`SessionIntegrityError`). |

### What Shade does NOT protect

| Not protected | Why |
|---|---|
| **Amounts** | Deposit and withdrawal amounts are public on-chain. |
| **The fact a payment occurred** | Fully visible. |
| **Fund flow** | **Shade is not a mixer.** A pool deposit and its withdrawal both name the same `stealth_pk`, so the flow is traceable. Only the link to your identity is hidden. |
| **Timing correlation** | Withdraw immediately after a deposit and the link is obvious. |
| **Amount-pattern correlation** | Distinctive amounts correlate deposits and withdrawals. |
| **The withdrawal destination** | Public — though it can be a fresh address with no history. |
| **Your behaviour** | Address reuse, a linked fee-payer, or a known destination will deanonymize you regardless of the cryptography. |

## Key-management assumptions

- **Spend private keys never leave the client.**
- **View keys enable scan-only access** — safe to delegate, but see the revocation limit below.
- **Stealth private keys exist only in memory** during a claim/withdraw.
- **All randomness** comes from the platform CSPRNG (`crypto.getRandomValues()` / `randomBytes`).
- **Keystores are encrypted by default** with AES-256-GCM (scrypt `N=131072, r=8, p=1`, files mode `0600`); `--plaintext` opts out.
- **Browser sessions** use PBKDF2-SHA256 (600k) → AES-256-GCM; only public keys are stored in the clear.

### The raw-scalar footgun

> **This one loses funds.** `recoverStealthPrivateKey` returns a **raw ed25519 scalar** (`k_spend + s mod L`), *not* a seed. It must be signed with `signWithStealthKey`. Constructing a keypair from it via `Keypair.fromRawEd25519Seed()` (or any seed-based API) **hashes** the input to a different signing scalar — the resulting key does not match the stealth public key, the contract rejects the signature, and **the funds become unwithdrawable**.

### Wallet-derived keys: an accepted trade-off

With the wallet-signature path, **wallet compromise equals stealth-key compromise** — anyone who can produce the signature can re-derive the keys. That is the accepted deal for keyless recovery.

Two hard rules:
- **Never sign the derivation message anywhere you don't trust.** Signing it hands over the ability to derive (and control) your stealth keys. The message includes an explicit warning line for exactly this reason.
- **The signer must be deterministic** (RFC 8032). A randomized signer derives different, unrecoverable keys on every call. The SDK verifies determinism by default (signs twice and compares) rather than letting you find out later.

### No view-key revocation

> **There is no undo.** Sharing your view key is **permanent and irreversible**. A viewer sees all your incoming payments, past and future. To stop them you must generate new keys and publish a new meta-address — and old payments remain visible to the old viewer.

## Cryptographic notes

- **Curve:** ed25519, order `L = 2^252 + 27742317777372353535851937790883648493`.
- **Primitives:** `@noble/curves` / `@noble/hashes` — the same audited primitives used broadly across the Stellar ecosystem — plus `@scure/bip39`.
- **The ECDH runs client-side by necessity.** Soroban's host exposes `ed25519_verify`, `sha256`, `secp256r1_verify`, and curve operations for **BLS12-381** (CAP-0059) and **BN254** — but **no Curve25519 scalar-multiplication host function**. The contract only ever *verifies* an ed25519 signature.
- **No BIP-32/44.** HD derivation uses domain-separated SHA-256, not standard BIP-32 paths (those are defined over secp256k1). Recovery works within Shade's own scheme.
- **Deterministic signing.** `signWithStealthKey` builds an RFC 8032-style signature directly from the raw scalar, with a deterministic nonce `r = SHA-512(scalar ‖ message) mod L`. Signatures verify with standard `ed25519.verify`.
- **Amount encryption** (`encryptAmount` / `decryptAmount`) is encrypt-then-MAC (XOR keystream + HMAC-SHA256) with constant-time tag verification. It is **not used by the pool contract** — it exists for applications built on top.

## Known limitations and open risks

### Protocol / product

- **Destination account must exist.** A pool withdrawal needs an active Stellar destination (its own ~1 XLM reserve). Fund it via an exchange withdrawal for best privacy, or use a relayer-sponsored claim.
- **`spp` is not implemented** — a reserved slot that always throws.
- **No external audit.**

### Implementation gaps worth knowing

- **`balance` and `withdraw` (CLI) do not page announcements.** They read announcements with a single capped request (limit 1000) rather than paging as `scan` does. In a pool with more than 1000 announcements, a payment at a higher index won't appear in `balance` and can't be resolved by `withdraw`. The contract itself supports O(1) keyed paging — this is a client-side gap.
- **Relayer defaults are permissive.** `RELAYER_REQUIRE_CREDIT=0` leaves `/relay` and `/sponsor-claim/submit` unauthenticated; `CORS_ORIGIN` defaults to `*`; an unset `RELAYER_SECRET` boots an unfunded random keypair. See [Relayer](./08-relayer.md#operational-warnings).
- **Relayer state is single-node and non-durable.** The credit ledger is a JSON file (wiped by an ephemeral-filesystem restart, taking consumed-tx idempotency with it); challenge nonces and rate-limit buckets are in-memory.
- **State archival.** If a `Balance`/`Nonce` entry archives, a withdraw over the archived footprint fails on-chain while `get_balance` still reports the funds. The SDK restores automatically; if the restore itself fails you get `EntryArchivedRestoringError` — **the funds are safe**, but the withdraw can't proceed until the entry is restored. Read-path TTL extension (`get_balance`/`get_nonce` bump a live entry back to ~1 year) makes this unlikely for anyone who scans periodically.

## User responsibility

The cryptography gives you the tools; you can still deanonymize yourself:

- **Vary timing.** Don't withdraw right after a deposit.
- **Vary amounts.** Partial withdrawals reduce correlation with the original deposit.
- **Use fresh destination addresses** with no history.
- **Never pay the fee from an account linked to you** — that's what the relayer is for.
- **Guard your view key.** Sharing it is permanent.

## Reporting

This project is pre-audit and provided as-is.

> **Found a vulnerability? Email [hello@stellar-shade.com](mailto:hello@stellar-shade.com).** Please report it privately rather than opening a public issue, so the problem can be fixed before it is widely known.

---

## Next steps

- [Core Concepts](./02-core-concepts.md) — the cryptography these guarantees rest on
- [Architecture](./03-architecture.md) — where each control is implemented
- [Relayer](./08-relayer.md) — operational hardening
- [FAQ & Troubleshooting](./10-faq-troubleshooting.md) — what specific errors mean
