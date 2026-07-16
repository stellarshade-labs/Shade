---
title: Architecture
description: "Shade's components: the Soroban pool contract, the crypto core, the SDK, the CLI and the relayer — plus the data flow for a full send, scan and claim cycle."
---

# Shade Architecture

Shade is a monorepo of four TypeScript packages plus one Soroban contract. This page maps each component to its job, then walks the data flow for a full send → scan → claim cycle.

---

## Components

```text
                        +-----------------------+
                        |    packages/crypto    |
                        |      (SDK core)       |
                        |                       |
                        | - DKSAP key derivation|
                        | - Stealth address gen |
                        | - ECDH shared secrets |
                        | - View tag scanning   |
                        | - HD keys (BIP-39)    |
                        | - Pure TS, no Stellar |
                        +-----------+-----------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
          +-------v--------+                 +--------v---------+
          | packages/sdk   |                 | packages/relayer |
          | (StealthClient)|                 | (fee-bump /      |
          |                |                 |  sponsor /       |
          | pool | account |                 |  credit)         |
          | adapters       |                 |                  |
          +-------+--------+                 +--------+---------+
                  |                                   |
          +-------v--------+                          |
          | packages/cli   |                          |
          | (shade)        |                          |
          +-------+--------+                          |
                  |                                   |
                  +-----------------+-----------------+
                                    |
                  +-----------------v-----------------+
                  |      contracts/registry           |
                  |      (Soroban pool contract)      |
                  |                                   |
                  | deposit()  — deposit + announce   |
                  | withdraw() — ed25519 sig verified |
                  | + 5 read-only getters             |
                  +-----------------------------------+
```

**Reading the diagram:** `crypto` is the dependency-free core everything builds on. The `sdk` wraps all network I/O behind delivery-method adapters. The `cli` is a reference consumer. The `relayer` is a standalone service that never imports `crypto` — it only handles transaction envelopes and credit accounting. Everything on the `pool` path terminates at the Soroban contract.

| Package | Role | Key dependency note |
|---|---|---|
| `@shade/crypto` | DKSAP math: keys, derivation, scanning, recovery, HD/mnemonic, raw-scalar signing | **Zero** `@stellar/stellar-sdk` dependency. Uses `@noble/curves`, `@noble/hashes`, `@scure/bip39`. Implements StrKey (`G...`) encoding itself, per **SEP-23**. |
| `@shade/sdk` | `StealthClient` — hides all Horizon/Soroban I/O behind `send`/`scan`/`claim`. Delivery adapters, typed errors, encrypted sessions, relayer client. | Depends on `@shade/crypto` + `@stellar/stellar-sdk`. |
| `@shade/cli` | The `shade` reference command-line tool. | Delegates the `account` method to the SDK; builds `pool` invocations inline. |
| `@shade/relayer` | Express service: fee-bump, sponsored claims, credit ledger. | Standalone — no `@shade/crypto` dependency. |
| `contracts/registry` | The Soroban pool contract (`StealthPoolContract`), Rust / `soroban-sdk`. | Single contract; calls SAC tokens for transfers. |

## The pool contract

### Public functions

The contract exposes seven functions — two that write, five read-only:

| Function | Kind | Purpose |
|---|---|---|
| `deposit(sender, token_addr, amount, stealth_pk, ephemeral_pk, view_tag)` | write | Atomic deposit + announcement. `sender.require_auth()`. |
| `withdraw(stealth_pk, token_addr, amount, destination, nonce, signature)` | write | Ed25519-verified withdrawal (no `require_auth`). |
| `get_balance(stealth_pk, token_addr) -> i128` | read | Pool balance for a (key, token) pair. **Extends the entry's TTL.** |
| `get_nonce(stealth_pk) -> u64` | read | Current replay-protection nonce. **Extends the entry's TTL.** |
| `get_announcements(start, limit) -> Vec<AnnouncementEntry>` | read | Paginated announcement window. Deserializes only `start..min(start+limit, count)`. `limit` uses `saturating_add`, so `u64::MAX` clamps instead of panicking. |
| `get_announcements_by_tag(view_tag) -> Vec<AnnouncementEntry>` | read | All announcements matching one view tag. |
| `get_announcement_count() -> u64` | read | Total announcements — a cheap freshness check. |

> **`get_announcements_by_tag` is a convenience, not the scanning path.** It iterates **every** index `0..count`, reading each keyed entry — O(n) storage reads, and its result grows with the number of matches, so it is only practical for small pools. The SDK deliberately does **not** use it: it pages `get_announcements` and filters by view tag **client-side**, which keeps the per-call work bounded and avoids leaking which tag you are interested in to the RPC node you query. Reach for it only for ad-hoc inspection of a small deployment.

### Storage layout

Storage is keyed, never a growing list — so a deposit's cost does **not** scale with history:

| Key | Value | Purpose |
|---|---|---|
| `Balance(stealth_pk, token)` | `i128` | Per-(key, token) balance. Not a mixer — each stealth key has its own isolated balance. |
| `Nonce(stealth_pk)` | `u64` | Replay protection; must strictly increase. |
| `Announcement(index)` | `AnnouncementEntry` | One announcement per own keyed entry — **O(1) append**, no history rewrite. |
| `AnnouncementCount` | `u64` | Total announcements; also the next index. |

All entries are **persistent** storage. TTLs are extended on write and, notably, **on read**: `get_balance` and `get_nonce` bump a live entry's TTL back up to the ceiling. That means a passively-scanning recipient keeps their own balance alive without ever writing.

```rust
const TTL_THRESHOLD: u32 = 518_400;    // ~30 days
const TTL_EXTEND_TO:  u32 = 6_312_000; // ~365 days
```

> **State archival.** Soroban archives persistent entries whose TTL lapses. If a `Balance`/`Nonce` entry does archive, a client must submit a `RestoreFootprintOp` before the next read/write — the SDK does this automatically (see below).

### Authorization model

Two different mechanisms, deliberately:

- **`deposit`** uses `sender.require_auth()` — the sender is a normal Stellar account, so standard Soroban auth applies.
- **`withdraw`** uses **`env.crypto().ed25519_verify`** on an explicit message — *not* `require_auth`. A stealth key is not a Stellar account and has no auth entry, so the contract verifies a raw signature instead. This is what lets **anyone** (a relayer, a friend, a fee-payer) submit the transaction on the recipient's behalf without being the recipient.

### The withdraw message

The signed message must be byte-identical between Rust and TypeScript:

```text
SHA256( stealth_pk(32)
      ‖ token_strkey_ascii(56)
      ‖ amount_be_i128(16)
      ‖ dest_strkey_ascii(56)
      ‖ nonce_be_u64(8)
      ‖ contract_strkey_ascii(56)
      ‖ network_id(32) )
```

The trailing **contract address** and **network id** (= `SHA-256(network passphrase)`, matching the on-chain `env.ledger().network_id()`) bind the signature to a single deployment on a single network, preventing cross-deployment and cross-network replay.

> **For developers.** Rust: `build_withdraw_message` in `contracts/registry/src/lib.rs`. TypeScript: `buildWithdrawMessage` in `packages/sdk/src/soroban.ts` (with 56-byte StrKey length assertions). A contract test (`test_withdraw_message_binds_contract_and_network`) proves a signature valid on deployment A is rejected on deployment B.

### Reentrancy safety

`withdraw` follows **checks-effects-interactions**: the nonce and balance are committed to storage **before** the external SAC `transfer` call, so a malicious token contract cannot re-enter and replay the withdrawal.

### Stellar Asset Contract (SAC)

The contract moves value through the standard token interface (`soroban_sdk::token::Client`), so it works with any **Stellar Asset Contract** — the contract that exposes a classic Stellar asset (native XLM, USDC, any issued asset) to Soroban. Cross-contract calls are limited to these SAC `transfer` calls:

- `deposit` → `transfer(sender → contract)`
- `withdraw` → `transfer(contract → destination)`

The SDK resolves an asset string to its SAC address with `resolveTokenAddress`, and `labelForToken` reverses the deterministic native-XLM SAC id back to the label `XLM` for display.

## Data flow: pool send → scan → claim

**1. Send** (`PoolAdapter.send`)
1. Decode the meta-address → `(K_spend, K_view)`
2. Draw a random 32-byte ephemeral `r`; derive `P`, `R`, `view_tag`
3. Resolve the asset to a SAC address; convert the amount to stroops
4. Build the `deposit(...)` invocation, `prepareTransaction`, sign (local secret or external signer), submit
5. Interpret the RPC result: only `SUCCESS` / `PENDING` / `DUPLICATE` count as landed; anything else throws (a `TRY_AGAIN_LATER` becomes a retryable error rather than a false success)

**2. Scan** (`PoolAdapter.scan`)
1. Read `get_announcement_count()` — a cheap freshness check that lets a caller skip a full scan
2. Page `get_announcements(start, limit)` from the cursor (200 per page)
3. Run the two-pass scan: ECDH + view-tag filter, then full derivation on tag matches
4. For each match, read `get_balance` and drop zero balances
5. Return payments plus an advanced cursor (the announcement index)

**3. Claim / withdraw** (`PoolAdapter.withdraw`)
1. Find the announcement matching the stealth address
2. `recoverStealthPrivateKey` → the raw stealth scalar
3. Read `get_balance` and `get_nonce`; the new nonce is `current + 1`
4. Build the withdraw message; sign it with `signWithStealthKey`
5. Build the `withdraw(...)` invocation sourced by the **fee payer**
6. **Restore-aware prepare** (below)
7. Sign the fee-payer leg; submit directly to RPC, or POST to the relayer's `/relay` for a fee-bump

### Restore-aware preparation

`server.prepareTransaction` only throws on a simulation *error* — it ignores `sim.restorePreamble`. If the recipient's `Balance`/`Nonce` entry has archived, a bare prepare would assemble the withdraw over an archived footprint: it submits, fails on-chain, and `get_balance` still shows the funds — an opaque brick.

`prepareWithRestore` (`packages/sdk/src/methods/restore.ts`) fixes this in three steps. On `isSimulationRestore` it builds and submits a `RestoreFootprintOp` from the preamble, then waits for it to land. Because that restore consumes the fee payer's next sequence number, it then **re-fetches the account and rebuilds the invocation on the fresh sequence**. Only then does it re-simulate. Without the rebuild, the withdraw would collide at an already-consumed sequence (`txBAD_SEQ`).

## Data flow: account method

The `account` method never touches the contract:

- **Send** — a classic transaction with the ephemeral `R` in a 32-byte `MemoHash`. Native XLM lands via `CreateAccount`/`Payment`; a token lands as a `CreateClaimableBalance` naming the stealth address as claimant.
- **Scan** — page Horizon transactions; for each hash-memo tx, decode the memo as a candidate `R`, derive the stealth address, and look for an operation whose destination matches. The destination match **is** the verification — no view tag needed.
- **Claim** — sign with the recovered stealth key: `AccountMerge` (full sweep) or `Payment` (partial) for XLM; `ChangeTrust` + `ClaimClaimableBalance` (+ optional exit) for a token, or a relayer-sponsored claim.

> **Ecosystem note.** The `account` method depends on Horizon paging. Stellar's official docs now describe **Horizon as deprecated in favour of Stellar RPC**, and Stellar RPC is explicitly *not* a historical indexer. A dedicated indexer for account-method scans is on the project's roadmap.

## Where the critical logic lives

| Concern | Location |
|---|---|
| Signature/message binding (anti-replay) | `contracts/registry/src/lib.rs` + `packages/sdk/src/soroban.ts` |
| Reentrancy ordering | `contracts/registry/src/lib.rs` (`withdraw`) |
| State-archival restore | `packages/sdk/src/methods/restore.ts` |
| Malicious-relayer defence | `packages/sdk/src/methods/account.ts` (`verifySponsoredClaimXdr`) |
| Small-subgroup / torsion rejection | `packages/crypto/src/ed25519.ts` (`validatePoint`) |
| Credit accounting, idempotency | `packages/relayer/src/ledger.ts` |

---

## Next steps

- [Delivery Methods](./04-delivery-methods.md) — choosing between `pool` and `account`
- [SDK Reference](./07-sdk-reference.md) — the API over this architecture
- [Relayer](./08-relayer.md) — the service in the diagram's right-hand branch
- [Security](./09-security.md) — the assumptions this architecture rests on
