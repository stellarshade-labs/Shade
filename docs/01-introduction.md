---
title: Introduction
description: "Shade gives every Stellar payment its own fresh, unlinkable stealth address. Publish one public handle; nobody watching the chain can tell those payments are yours."
---

# What is Shade?

Shade gives every payment its own fresh, unlinkable address on Stellar. You publish **one** public handle; anyone can pay you, but nobody watching the chain can tell those payments are yours — or that they're related to each other.

This page explains what Shade is, the problem it solves, and who it's for. If you want to start using it, jump to [Getting Started](./05-getting-started.md).

**Try it in three commands** (needs Node.js 20+, Docker, Stellar CLI and a Rust toolchain — the demo deploys the contract, runs a relayer, and walks a full send → scan → claim cycle on a local network):

```bash
npm install
docker compose up -d
bash demo.sh
```

Full setup in [Getting Started](./05-getting-started.md).

---

## The problem: your address is a glass mailbox

On a normal blockchain, your address is public and permanent. Every payment to it is visible and tied to you forever. Reuse it and the whole world sees your balance and your history.

Shade gives you a **new mailbox for every single payment** — and only *you* can tell which mailboxes are yours. You hand out one public **meta-address**; senders use it to compute a brand-new one-time address each time. On-chain, those addresses look unrelated to you and to each other.

## What Shade does — and does not — hide

This distinction is the single most important thing to understand:

Three terms first, so the table below reads cleanly. Full definitions are in [Core Concepts](./02-core-concepts.md):

- **Stealth address** — the fresh one-time address a sender computes from your meta-address. On-chain it looks like any ordinary Stellar address.
- **View key** — one half of your identity. It can **find** payments sent to you, but **cannot spend** them. Safe to delegate; the other half, the **spend key**, moves the money and never leaves you.
- **Relayer** — an optional helper service that pays a transaction fee on your behalf, so claiming your money doesn't reveal a wallet of your own. See [Relayer](./08-relayer.md).

| | |
|---|---|
| **Hides** | *Who* the recipient is. A stealth address is unlinkable to your meta-address without your view key. |
| **Hides** | Which funded accounts you control — a relayer can pay the transaction fee so your own wallet never appears. |
| **Does NOT hide** | That *a* payment happened, or its amount. |
| **Does NOT hide** | The flow of funds. Shade is **not a mixer**: a pool deposit and its withdrawal both name the same stealth key on-chain. |
| **Does NOT hide** | Timing correlation. Withdraw right after a deposit and the link is obvious. |

**Privacy here is about identity, not invisibility.** The cryptography gives you the tools; behaviour (timing, amount patterns, address reuse) can still deanonymize you.

## Why Stellar needed a different design

Stellar charges a **minimum balance reserve (MBR)** of ~1 XLM for every account that exists. A naive stealth-address implementation creates one account per payment and locks ~1 XLM in each. On chains where accounts are free or negligible, that's fine; on Stellar it makes per-payment accounts impractical.

Shade's answer is a **Soroban pool contract** that holds funds with per-stealth-key accounting, so no new account is created per payment. The cost drops from ~1 XLM of locked reserve to a Soroban invocation fee (on the order of ~0.01 XLM).

> **For developers.** The pool is a single Soroban contract (`contracts/registry`). It keys balances by `(stealth_pk, token)` and authorizes withdrawals by **ed25519 signature verification** — not `require_auth` — because a stealth key is not a Stellar account. See [Architecture](./03-architecture.md).

## Who this is for

- **People receiving payments** who don't want a public, permanent link between their identity and every incoming transfer — freelancers, donation recipients, anyone publishing a payment handle.
- **Application developers** who want stealth payments without implementing elliptic-curve math or hand-building Soroban transactions. See the [SDK Reference](./07-sdk-reference.md).
- **Wallet and tooling builders** who want the primitives only. `@shade/crypto` is pure TypeScript with **zero** `@stellar/stellar-sdk` dependency.

## What's implemented today

- Two delivery methods — **`pool`** (Soroban contract; works with any **SAC** token, i.e. any asset exposed to Soroban via a *Stellar Asset Contract* — native XLM, USDC, anything issued) and **`account`** (a direct one-time Stellar account, or a *claimable balance* — a pending transfer the recipient later claims). See [Delivery Methods](./04-delivery-methods.md).
- A **relayer** for fee-bumping and reserve-fronting. See [Relayer](./08-relayer.md).
- External signing via **Freighter** (the Stellar browser wallet), encrypted browser sessions, and wallet-signature key derivation.
- A reference **CLI** (`shade`) and a **TypeScript SDK**.

## Status: pre-audit, not for mainnet

The protocol and this implementation have **not undergone an external cryptographic audit**. Treat the project as production-track but pre-audit, and do not put mainnet value at risk. Read [Security](./09-security.md) before going further.

---

## Next steps

- [Core Concepts](./02-core-concepts.md) — DKSAP (the Dual-Key Stealth Address Protocol Shade is built on), view/spend keys, meta-addresses, view tags
- [Architecture](./03-architecture.md) — the components and how data flows between them
- [Getting Started](./05-getting-started.md) — run it locally
- [Security](./09-security.md) — threat model, assumptions, and limits
