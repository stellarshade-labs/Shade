---
title: Delivery Methods
description: "Compare Shade's delivery methods: the Soroban pool contract versus a direct one-time Stellar account — where funds sit, what they cost, and how you claim them."
---

# Delivery Methods: Pool vs Account

The same meta-address works with more than one "delivery method" — the mechanism that actually carries money to the recipient. They differ in where funds sit, what they cost, and how you claim them. This page compares them and tells you which to pick.

---

## The three slots

`DeliveryMethod = 'pool' | 'account' | 'spp'`

| | **pool** | **account** | **spp** |
|---|---|---|---|
| **Status** | ✅ Implemented | ✅ Implemented | ⏳ Reserved slot — *not built* |
| **Where funds sit** | Shared Soroban **pool contract**, keyed by your stealth key | A one-time real Stellar **account** / claimable balance | — |
| **New account created?** | **No** — no ~1 XLM reserve locked | **Yes** — ~1 XLM base reserve required | — |
| **Assets** | Any SAC token (XLM, USDC, …) | Native XLM, or any classic/SAC asset (as a claimable balance) | — |
| **Discovery** | Contract **announcements** + **view-tag** fast path (~2×) | **Horizon** paging for the ephemeral key in a `MemoHash`, then destination match (no view tag) | — |
| **Claim** | Signature-verified `withdraw` — **no Stellar account needed** | Sign with the recovered stealth key, or a relayer-sponsored payout | — |
| **Cost profile** | Soroban invocation fee (~0.01 XLM) | ~1 XLM reserve (native) or ~1.5 XLM fronted (token) | — |

**Rule of thumb:** use **`pool`** for the best privacy/cost trade-off and any token — you never need a funded account to claim. Use **`account`** for the simplest path that works with vanilla Horizon tooling.

## `pool` — the Soroban contract

Money is deposited into the pool contract and tracked under `Balance(stealth_pk, token)`. No Stellar account is ever created for the stealth key, so **no ~1 XLM MBR is locked**.

The deposit and its announcement are written **atomically** — no deposit, no announcement — which makes announcement spam impossible.

**Claiming** calls `withdraw(...)` with an ed25519 signature over the [withdraw message](./03-architecture.md#the-withdraw-message). Because authorization is a signature rather than `require_auth`, *anyone* can submit the transaction for you. Two ways to pay the Soroban fee:

1. **Direct** — you supply a fee-payer account and submit to RPC yourself.
2. **Relayer fee-bump** — POST to the relayer's `/relay`; it fee-bumps the transaction. See [Relayer](./08-relayer.md).

> **What relaying a pool withdraw hides — and what it doesn't.** A relayed pool withdraw hides **who pays the fee** (the relayer fee-bumps it), but **not who authored it**: the fee-payer account you pass is the inner transaction's on-chain `source_account`, which is **publicly visible**. So pool relay gives **fee-payer privacy, not inner-author unlinkability**. When author unlinkability matters, use a **throwaway funded fee-payer per withdraw**, or the account method's **sponsored-claim** flow (where the relayer itself is the inner source). Either way, relaying stays **trustless**: the withdraw signature binds the destination, amount, contract, and network, so a relayer cannot redirect or tamper with the withdrawal.

You may withdraw the **full balance or a partial amount** (`opts.amount`).

**Requirements and caveats**
- `contractId` is **required** whenever the pool method is enabled — there is no built-in default. A `testnet` client with pool enabled and no explicit `contractId` throws `ContractIdRequiredError`.
- The withdrawal **destination must be an existing Stellar account** (it needs its own reserve to exist).
- **Not a mixer.** The deposit and the withdraw both name the same `stealth_pk` on-chain, so the *flow* remains traceable; only the link to your identity is hidden.

## `account` — a direct one-time account

Money goes to a real, one-time Stellar account. The ephemeral key `R` travels in the transaction's 32-byte `MemoHash`; discovery derives the stealth address from `(k_view, R)` and looks for an operation whose destination matches. That destination match **is** the full DKSAP verification, so no view tag is needed.

> **Muxed (`M...`) addresses are handled.** A muxed address shares one underlying `G...` account across many virtual sub-accounts. During scanning, every destination is normalized to its underlying ed25519 account id before comparison, so a payment addressed to the **muxed form** of your stealth address still matches the derived `G...` address and is discovered normally. This applies to `create_account` / `payment` destinations **and** to `create_claimable_balance` claimants. Plain `G...` inputs (and anything unparseable) pass through unchanged, so ordinary matching is unaffected.
>
> **For developers.** `normalizeDestination` in `packages/sdk/src/methods/account.ts`, via `MuxedAccount.fromAddress(address, '0').baseAccount().accountId()`. Note this normalizes for **matching only** — Shade never *derives* a muxed stealth address; the sender always creates a plain `G...` one-time account.

### Native XLM

Sent via `CreateAccount` (falling back to `Payment` if the account already exists). The amount **must be strictly greater than 1 XLM** — below that the account cannot meet its base reserve — otherwise you get `MinimumAmountError`.

Claiming:
- **Full sweep** (default, `merge: true`) — `AccountMerge` delivers the entire balance including the reserve to your destination.
- **Partial** (`merge: false`) — a `Payment` that leaves the account open. The account must retain **2× the base reserve (1.0 XLM)** plus the fee; an over-large request throws `ClaimAmountError` with the maximum named.

Either can be relayer fee-bumped.

### Tokens (USDC and friends)

One transaction with two operations: `CreateAccount(stealth, 1.5001 XLM)` to open the account with trustline headroom, then `CreateClaimableBalance(asset, amount, claimant: stealth)`. The sender fronts those reserves:

| Portion | Purpose |
|---|---|
| ~1 XLM | Base account reserve |
| ~0.5 XLM | Trustline reserve headroom |
| ~0.0001 XLM | Fee slack |

The 0.5 XLM claimable-balance reserve returns to the **sender** when the balance is claimed.

Claiming a token has two paths:
1. **Self-funded** — the stealth account exists and can pay: `ChangeTrust` → `ClaimClaimableBalance` → (optional full exit: `Payment` → `ChangeTrust(limit 0)` → `AccountMerge`).
2. **Sponsored** (`sponsored: true`, or automatically when the account stub is missing) — the relayer fronts the reserves under a **sponsorship sandwich** (a Stellar pattern where operations are wrapped between `BeginSponsoringFutureReserves` and `EndSponsoringFutureReserves`, so the sponsor pays the reserves instead of the account itself) and co-signs, so you can cash out to a **fresh, unfunded address**. See [Relayer](./08-relayer.md).

**Requirement:** the destination must already **trust the asset**, or you get `DestinationTrustlineError` before anything is submitted.

## `auto` — letting the client choose

`method: 'auto'` is not a fourth method; it resolves to a real one at call time:

> native asset **AND** amount > 1 **AND** `'account'` enabled → **`account`**; otherwise → **`pool`**.

There is deliberately **no implicit default**: every `send()` must pass a method (or `'auto'`), or it throws `MethodRequiredError`. The privacy trade-off should always be a conscious choice.

## `spp` — reserved, not implemented

`spp` is a **reserved enum slot** for a possible future integration with a *separate, external* Stellar private-payments effort. It implements the full adapter surface so an application could opt in later with zero API changes — but **every method throws `MethodNotAvailableError`** today.

**Shade does not build `spp`, and it is not on the roadmap.** It exists only as a hook.

## Choosing

| If you want… | Use |
|---|---|
| Best privacy/cost trade-off; any SAC token | `pool` |
| To claim without ever having a funded account | `pool` (fee-bumped) or `account` + sponsored claim |
| To avoid locking ~1 XLM per payment | `pool` |
| Compatibility with plain Horizon tooling | `account` |
| Simple XLM transfer with a familiar on-chain shape | `account` |

---

## Next steps

- [Core Concepts](./02-core-concepts.md) — what a view tag and announcement actually are
- [Architecture](./03-architecture.md) — the data flow behind each method
- [SDK Reference](./07-sdk-reference.md) — `SendOpts` / `ClaimOpts` for each method
- [Relayer](./08-relayer.md) — fee-bumping and sponsored claims
