---
title: Architecture
description: "Shade's components: the Soroban pool contract, the crypto core, the SDK, the CLI, the relayer and the announcement indexer, plus the data flow for a full send, scan and claim cycle."
---

# Shade Architecture

Shade is a monorepo of five TypeScript packages plus one Soroban contract. This page maps each component to its job, then walks the data flow for a full send → scan → claim cycle.

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
          +-------v--------+                 +--------v---------+  +------------------+
          | packages/sdk   |                 | packages/relayer |  | packages/indexer |
          | (StealthClient)|                 | (fee-bump /      |  | (announcement    |
          |                |                 |  sponsor /       |  |  candidate feed  |
          | pool | account |                 |  credit)         |  |  from Horizon)   |
          | adapters       |                 |                  |  |                  |
          +-------+--------+                 +--------+---------+  +------------------+
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

**Reading the diagram:** `crypto` is the dependency-free core everything builds on. The `sdk` wraps all network I/O behind delivery-method adapters. The `cli` is a reference consumer. The `relayer` is a standalone service that never imports `crypto`; it only handles transaction envelopes and credit accounting. The `indexer` is a second standalone service: it watches Horizon's transaction feed and serves the account method's [announcement-candidate feed](#the-announcement-indexer), with no `crypto` (or even `@stellar/stellar-sdk`) dependency, and it never touches the contract. Everything on the `pool` path terminates at the Soroban contract.

| Package | Role | Key dependency note |
|---|---|---|
| `@shade/crypto` | DKSAP math: keys, derivation, scanning, recovery, HD/mnemonic, raw-scalar signing | **Zero** `@stellar/stellar-sdk` dependency. Uses `@noble/curves`, `@noble/hashes`, `@scure/bip39`. Implements StrKey (`G...`) encoding itself, per **SEP-23**. |

| `stellar-shade` | `StealthClient`, which hides all Horizon/Soroban I/O behind `send`/`scan`/`claim`. Delivery adapters, typed errors, encrypted sessions, relayer client. | Depends on `@shade/crypto` + `@stellar/stellar-sdk`. |
| `@shade/cli` | The `shade` reference command-line tool. | Delegates the `account` method to the SDK; builds `pool` invocations inline. |
| `@shade/relayer` | Express service: fee-bump, sponsored claims, credit ledger. | Standalone, with no `@shade/crypto` dependency. |
| `@shade/indexer` | Express service: ingests Horizon's transaction feed once for everyone and serves the account method's announcement-candidate feed. | Standalone, with no `@shade/crypto` **or** `@stellar/stellar-sdk` dependency; builds and runs alone. |
| `contracts/registry` | The Soroban pool contract (`StealthPoolContract`), Rust / `soroban-sdk`. | Single contract; calls SAC tokens for transfers. |

## The pool contract

### Public functions

The contract exposes seven functions: two that write, five read-only:

| Function | Kind | Purpose |
|---|---|---|
| `deposit(sender, token_addr, amount, stealth_pk, ephemeral_pk, view_tag)` | write | Atomic deposit + announcement. `sender.require_auth()`. |
| `withdraw(stealth_pk, token_addr, amount, destination, nonce, signature)` | write | Ed25519-verified withdrawal (no `require_auth`). |
| `get_balance(stealth_pk, token_addr) -> i128` | read | Pool balance for a (key, token) pair. **Extends the entry's TTL.** |
| `get_nonce(stealth_pk) -> u64` | read | Current replay-protection nonce. **Extends the entry's TTL.** |
| `get_announcements(start, limit) -> Vec<AnnouncementEntry>` | read | Paginated announcement window. Deserializes only `start..min(start+limit, count)`. `limit` uses `saturating_add`, so `u64::MAX` clamps instead of panicking. |
| `get_announcements_by_tag(view_tag, start, limit) -> Vec<AnnouncementEntry>` | read | Paginated window filtered to one view tag. Same bounds as `get_announcements`: scans only `start..min(start+limit, count)`, with the `saturating_add` clamp. |
| `get_announcement_count() -> u64` | read | Total announcements; a cheap freshness check. |

> **`get_announcements_by_tag` is a convenience, not the scanning path.** It is paginated like `get_announcements`: each call reads only the `start..start+limit` window and returns the matches within it, so callers page it the same way. The SDK deliberately does **not** use it. It pages `get_announcements` and filters by view tag **client-side**, which avoids leaking which tag you are interested in to the RPC node you query. Reach for it only for ad-hoc inspection.

### Storage layout

Storage is keyed, never a growing list, so a deposit's cost does **not** scale with history:

| Key | Value | Purpose |
|---|---|---|
| `Balance(stealth_pk, token)` | `i128` | Per-(key, token) balance. Not a mixer: each stealth key has its own isolated balance. |
| `Nonce(stealth_pk)` | `u64` | Replay protection; must strictly increase. |
| `Announcement(index)` | `AnnouncementEntry` | One announcement per own keyed entry: **O(1) append**, no history rewrite. |
| `AnnouncementCount` | `u64` | Total announcements; also the next index. |

All entries are **persistent** storage. TTLs are extended on write and, notably, **on read**: `get_balance` and `get_nonce` bump a live entry's TTL back up to the ceiling. That means a passively-scanning recipient keeps their own balance alive without ever writing.

```rust
const TTL_THRESHOLD: u32 = 518_400;    // ~30 days
const TTL_EXTEND_TO:  u32 = 6_312_000; // ~365 days
```

> **State archival.** Soroban archives persistent entries whose TTL lapses. If a `Balance`/`Nonce` entry does archive, a client must submit a `RestoreFootprintOp` before the next read/write. The SDK does this automatically (see below).

### Authorization model

Two different mechanisms, deliberately:

- **`deposit`** uses `sender.require_auth()`. The sender is a normal Stellar account, so standard Soroban auth applies.
- **`withdraw`** uses **`env.crypto().ed25519_verify`** on an explicit message, *not* `require_auth`. A stealth key is not a Stellar account and has no auth entry, so the contract verifies a raw signature instead. This is what lets **anyone** (a relayer, a friend, a fee-payer) submit the transaction on the recipient's behalf without being the recipient.

### The withdraw message

The signed message must be byte-identical between Rust and TypeScript, a fixed **278-byte** preimage:

```text
SHA256( domain_tag(22)          ‖ "SHADE-POOL-WITHDRAW-V1" ASCII
      ‖ stealth_pk(32)
      ‖ token_strkey_ascii(56)
      ‖ amount_be_i128(16)
      ‖ dest_strkey_ascii(56)
      ‖ nonce_be_u64(8)
      ‖ contract_strkey_ascii(56)
      ‖ network_id(32) )
```

The leading 22-byte ASCII **domain tag** `SHADE-POOL-WITHDRAW-V1` (SH-3) separates a withdraw preimage from any other message a stealth key might sign. The trailing **contract address** and **network id** (= `SHA-256(network passphrase)`, matching the on-chain `env.ledger().network_id()`) bind the signature to a single deployment on a single network, preventing cross-deployment and cross-network replay.

> **For developers.** Rust: `build_withdraw_message` in `contracts/registry/src/lib.rs`. TypeScript: `buildWithdrawMessage` in `packages/sdk/src/soroban.ts` (with 56-byte StrKey length assertions). The contract test `test_withdraw_message_binds_contract_and_network` proves a signature valid on deployment A is rejected on deployment B.

### Reentrancy safety

`withdraw` follows **checks-effects-interactions**: the nonce and balance are committed to storage **before** the external SAC `transfer` call, so a malicious token contract cannot re-enter and replay the withdrawal.

### Stellar Asset Contract (SAC)

The contract moves value through the standard token interface (`soroban_sdk::token::Client`), so it works with any **Stellar Asset Contract** (native XLM, USDC, any issued asset). Cross-contract calls are limited to these SAC `transfer` calls:

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
1. Read `get_announcement_count()`, a cheap freshness check that lets a caller skip a full scan
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

`server.prepareTransaction` only throws on a simulation *error*; it ignores `sim.restorePreamble`. If the recipient's `Balance`/`Nonce` entry has archived, a bare prepare would assemble the withdraw over an archived footprint: it submits, fails on-chain, and `get_balance` still shows the funds, an opaque brick.

`prepareWithRestore` (`packages/sdk/src/methods/restore.ts`) fixes this in three steps. On `isSimulationRestore` it builds and submits a `RestoreFootprintOp` from the preamble, then waits for it to land. Because that restore consumes the fee payer's next sequence number, it then **re-fetches the account and rebuilds the invocation on the fresh sequence**. Only then does it re-simulate. Without the rebuild, the withdraw would collide at an already-consumed sequence (`txBAD_SEQ`).

## Data flow: account method

The `account` method never touches the contract:

- **Send:** a classic transaction with the ephemeral `R` in a 32-byte `MemoHash`. Native XLM lands via `CreateAccount`/`Payment`; a token lands as a `CreateClaimableBalance` naming the stealth address as claimant.
- **Scan:** page Horizon transactions; for each hash-memo tx, decode the memo as a candidate `R`, derive the stealth address, and look for an operation whose destination matches. The destination match **is** the verification, no view tag needed. With an [indexer](#the-announcement-indexer) configured, the covered span of that walk consumes the indexer's pre-extracted candidate feed instead (operations inlined, no per-tx round-trip), and a Horizon tail always runs last.
- **Claim:** sign with the recovered stealth key: `AccountMerge` (full sweep) or `Payment` (partial) for XLM; `ChangeTrust` + `ClaimClaimableBalance` (+ optional exit) for a token, or a relayer-sponsored claim.

> **Ecosystem note.** The `account` method depends on Horizon paging. Stellar's official docs now describe **Horizon as deprecated in favour of Stellar RPC**, and Stellar RPC is explicitly *not* a historical indexer. The dedicated indexer for account-method scans has shipped: [the announcement indexer](#the-announcement-indexer), next.

## The announcement indexer

The `account` method publishes **no view tag**: the transaction's `MemoHash` *is* the ephemeral key `R`. Every hash-memo transaction on the network is therefore a discovery candidate, and the original scan walked the **global Horizon transaction feed client-side**: minutes for a cold scan on testnet, unbounded as a network grows.

The **announcement indexer** (`packages/indexer`, a standalone service like the relayer) moves that walk server-side, **once for everyone**. It polls Horizon `/transactions?order=asc`, keeps **only** successful hash-memo transactions (their operation records stored **verbatim**) and serves them as a compact candidate feed the client filters **locally**. There is deliberately **no address- or R-keyed query**: any such query would let the operator link your keys to your requests.

### Trust model

**An indexer can *hide* payments; it cannot *fabricate* them.** A candidate only becomes "your payment" after the client itself derives the stealth address from `R`, and everything is re-verified on-chain at claim time. The indexer is an **availability optimization**; **Horizon remains the source of truth**:

- The scan probes the indexer's `/health` first and silently stays on the pure Horizon walk when the indexer is unreachable, unhealthy (any degraded coverage state, see below), on the wrong network, or self-reporting more lag than `ClientConfig.indexerMaxLagSeconds` (default 6 h; an operationally abandoned indexer is not worth electing).
- Every scan **finishes with a Horizon tail** from the final cursor, so indexer lag cannot hide a payment.
- An indexer fault **mid-scan** degrades automatically to the Horizon walk from the last good cursor.
- After the covered span, the scan **re-checks `/health` once more**: a gap the indexer recorded *while the scan was consuming its feed* discards the segment's results, and the tail re-walks the whole span, so a mid-scan hole can never advance the client cursor past a payment.
- The persisted cursor is **clamped to the head the client's own Horizon reports** whenever the tail saw nothing: one malicious far-future cursor cannot blind future scans (they would otherwise resume beyond the chain head and find nothing, forever).
- Cursors are Horizon `paging_token`s, so indexer and Horizon cursors are **interchangeable in both directions**.

### Cold scans and coverage

With no saved cursor and a healthy indexer, a scan **fast-starts at the indexer's coverage start** (`startCursor` from `/health`) instead of genesis. The trade-off: a payment predating the indexer's coverage is found only by the **exhaustive walk** (CLI `--full-rescan`, SDK `ScanOpts.exhaustive`), which walks the pre-indexer prefix on Horizon from genesis (the indexer still serves the covered span).

### Coverage honesty

A coverage claim is only useful if the indexer **owns its failures**. The ingester runs a periodic **feed continuity check** against Horizon's retention bounds, and because a recorded gap is *permanent*, the check fails **closed** in every direction: ingestion never starts before the process's first successful check (a cold start against a broken root document must not silently cross a retention hole); bounds from a root document reporting a different network passphrase are discarded (a mistyped `HORIZON_URL` cannot poison the gap store); and a hole (starting at the cursor ledger itself, whose tail may be partially unserved) is recorded only after **two consecutive observations**, with paging paused in between.

Every failure mode degrades `/health` (`status: 'degraded'`, each cause exposed individually): a recorded **gap**, a **suspected testnet reset** (cursor impossibly far past the chain head, confirmed twice and then *latched* until restart, so a stale-era database never becomes trustworthy again just because the new chain outgrows it), a **persistently failing continuity check** (`continuityStale`: gap/reset detection is effectively off, so coverage cannot be vouched for), and a **stalled ingest loop** (`stalled`: a frozen indexer must not report `ok` forever). SDK guards require `status: 'ok'`, so every degraded state routes clients back to Horizon automatically. A hole can never *hide* a payment, it only costs speed.

### Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /health` | `status` (`ok`\|`degraded`, see [Coverage honesty](#coverage-honesty)), `network`, `store` (`postgres`\|`memory`), `cursor`, `startCursor`, `lastCloseTime`, `lagSeconds`, `announcements` (count), recorded feed `gaps` (always present, `[]` when none), `ingest` (`lastPollAt`, `lastError`, `resetSuspected`, `lastContinuityOkAt`, `continuityStale`, `stalled`) |
| `GET /announcements?cursor=&limit=` | Hash-memo candidate records (Horizon transaction shape, `operations` inlined verbatim, plus the transaction's `source_account`; rows ingested before the field existed omit it) strictly after `cursor`; `limit` capped at 200. The response `cursor` resumes paging, jumping to the indexer's global position once the feed is drained |

Both endpoints are rate limited per client IP: `429` with a `Retry-After` reporting the real remaining wait. The SDK treats a `429` as a fault (Horizon fallback), so the `/announcements` default is generous.

### Configuration

All configuration is environment variables. `packages/indexer/.env.example` is the annotated list:

| Variable | Default | Purpose |
|---|---|---|
| `NETWORK` | `testnet` | Target network; unknown values (incl. the removed `local`) refuse to boot (exit 1) |
| `PORT` | `3100` | Listen port |
| `HORIZON_URL` | per-network table | Horizon override (tests, private Horizons) |
| `DATABASE_URL` | — | Postgres backing announcements + the ingest cursor (durable across restarts). **Set-but-unreachable → exit 1**, never a silent memory fallback. Unset → **in-memory store**: announcements are lost on restart and re-ingested from `INGEST_START` |
| `PGPOOL_MAX` | `5` | Max Postgres pool connections (free tiers cap low) |
| `PGSSL` | — | `true` forces TLS even without `sslmode=require` in the URL |
| `INGEST_START` | `now` | Where a **fresh** store starts ingesting: `now`, `genesis`, or a decimal Horizon paging token. Applies only before any cursor is persisted; the stored position always wins |
| `INGEST_INTERVAL_MS` | `3000` | Poll interval between ingest ticks (a cold catch-up drains the whole backlog within a single tick regardless) |
| `GAP_CHECK_INTERVAL_MS` | `600000` | Feed continuity check cadence (see [Coverage honesty](#coverage-honesty)) |
| `ANNOUNCEMENTS_RPM` / `HEALTH_RPM` | `600` / `120` | Per-IP rate limits (token bucket, per instance) |
| `TRUST_PROXY_HOPS` | — | Trusted reverse-proxy hops: the limiter keys clients by the rightmost non-forgeable `X-Forwarded-For` entry (must parse as an IP, else socket fallback). Unset → the header is ignored. When set, the origin port must be reachable **only** through the proxy chain |
| `CORS_ORIGIN` | `*` | Allowed origin, permissive **on purpose** here, unlike the relayer: the candidate feed is public data anyone can read off Horizon |

> **Ingest guarantee.** The cursor **never advances past a transaction whose operations fetch failed**: the tick aborts before that page is written and the next tick retries from the same cursor. An announcement silently skipped would be a hidden payment.

Run it with `npm run dev` in `packages/indexer` (or `npm run build` + `npm run start`); point clients at it via the SDK's `indexerUrl` or the CLI's `--indexer` / `SHADE_INDEXER`.

## Where the critical logic lives

| Concern | Location |
|---|---|
| Signature/message binding (anti-replay) | `contracts/registry/src/lib.rs` + `packages/sdk/src/soroban.ts` |
| Reentrancy ordering | `contracts/registry/src/lib.rs` (`withdraw`) |
| State-archival restore | `packages/sdk/src/methods/restore.ts` |
| Malicious-relayer defence | `packages/sdk/src/methods/account.ts` (`verifySponsoredClaimXdr`) |
| Small-subgroup / torsion rejection | `packages/crypto/src/ed25519.ts` (`validatePoint`) |
| Credit accounting, idempotency | `packages/relayer/src/ledger.ts` |
| Indexer fallback + Horizon-tail scan segmentation | `packages/sdk/src/methods/account.ts` (`scan`) |
| Ingest never-skip cursor invariant | `packages/indexer/src/ingest.ts` |

---

## Next steps

- [Delivery Methods](./04-delivery-methods.md): choosing between `pool` and `account`
- [SDK Reference](./07-sdk-reference.md): the API over this architecture
- [Relayer](./08-relayer.md): the service in the diagram's right-hand branch
- [Security](./09-security.md): the assumptions this architecture rests on
