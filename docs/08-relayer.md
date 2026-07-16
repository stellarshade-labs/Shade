---
title: Relayer
description: "The Shade relayer: fee-bumping, sponsored claims and the credit system — endpoints, proof-of-control auth, configuration and operational warnings."
---

# The Shade Relayer

The relayer is the reference service (`packages/relayer`) that an app or community runs. It solves a chicken-and-egg problem: to claim your money you'd normally need a funded Stellar account to pay the fee — but *using* a funded account links it to you, undoing the privacy.

This page covers what it does, its endpoints, the credit system, configuration, and deployment.

---

## What it solves

- **Fee-bump** (`/relay`) — the relayer pays your withdrawal's fee, so you never reveal a funded account of your own. This is purely about **privacy**: the relayer sees the transaction envelope but learns nothing about your other accounts.
- **Reserve fronting / sponsored claims** (`/sponsor`, `/sponsor-claim/*`) — it fronts the ~1 XLM account reserve (plus ~0.5 XLM trustline reserve for tokens) so you can cash out to a **fresh, unfunded address**.

> **There is no hosted or hard-coded relayer URL.** "Default" only ever means the reference service *you* deploy and point your app at. The relayer is standalone — it has no dependency on `@shade/crypto`.

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /health` | Status, network, relayer address, balance, `requireCredit` |
| `POST /relay` | Fee-bump and submit a signed transaction |
| `POST /sponsor` | Create a stealth account (funded `CreateAccount` from the relayer) |
| `POST /sponsor-claim/prepare` | Build an unsigned sponsored-claim transaction |
| `POST /sponsor-claim/submit` | Co-sign + submit a sponsored claim |
| `POST /credit/claim` | Top up credit by proving an XLM payment via `txHash` |
| `GET /credit/challenge` | Issue a proof-of-control nonce |
| `GET /credit/:account` | Read a credit balance |

### `POST /relay`

Body: `{ xdr, fundingAccount?, nonce?, signature? }` → `{ txHash, success: true }`

Wraps your signed inner transaction in a fee-bump and submits it. Abuse guards apply on **every** path, credit-gated or not:

| Guard | Default |
|---|---|
| Max operations in the inner tx | 5 (`MAX_RELAY_OPS`) |
| Timebounds must be present, unexpired, and bounded | ≤ now + 600s (`MAX_RELAY_TIMEBOUNDS_SECONDS`) |
| Memos | **Forbidden** — a relayed withdrawal has no legitimate memo, and one could leak or tag metadata |
| Fetched base fee clamp | 10,000 stroops (`MAX_BASE_FEE`) |
| Absolute outer fee cap | 0.1 XLM (`MAX_RELAY_FEE_XLM`) |

### `POST /sponsor`

Body: `{ address, startingBalance?, fundingAccount, nonce, signature }` → `{ txHash, stealthAddress }`

Creates a stealth account with a plain funded `CreateAccount`. **Fail-closed by design:** this route *always* requires an authenticated funding account and *always* debits `startingBalance + fee` from its credit, regardless of `RELAYER_REQUIRE_CREDIT` — so it can never be used as a free XLM faucet. `startingBalance` is capped at `SPONSOR_MAX_XLM` (default 5).

There is deliberately **no sponsorship sandwich** here: `EndSponsoringFutureReserves` must be signed by the sponsored account, whose key nobody holds at creation time. The sandwich lives only in `/sponsor-claim`, where the client holds the stealth key and co-signs.

### `POST /sponsor-claim/prepare` and `/submit`

**prepare** — body `{ stealthAddress, asset, balanceId, destination, amount }` → `{ xdr, expiresAt }`

Builds a relayer-sourced, **unsigned** transaction (60-second timebounds) with this exact operation sequence:

```text
BeginSponsoringFutureReserves(sponsored: stealth)
[CreateAccount(stealth, startingBalance '0')]   ← only if the account doesn't exist
ChangeTrust(asset, source: stealth)
EndSponsoringFutureReserves(source: stealth)
ClaimClaimableBalance(balanceId, source: stealth)
Payment(destination, asset, amount, source: stealth)
```

The payout rides in the same transaction because a stealth account created with `startingBalance: '0'` under sponsorship can never pay a fee to move the tokens itself. It also verifies up front that the destination exists and already trusts the asset.

**submit** — body `{ xdr, stealthAddress, asset, balanceId, destination, amount, fundingAccount?, nonce?, signature? }` → `{ txHash }`

The client attaches its stealth signature and returns the XDR. The relayer then rebuilds the expected operation list from the **trusted inputs** and compares field-by-field (type, per-op source, destination, asset, amount, balanceId, sponsoredId) before adding its own signature. A client cannot mutate any operation and still pass. It also enforces a per-op fee cap (200 stroops/op), the advertised 60-second TTL, and a no-memo rule.

> **Two-sided verification.** The relayer's check protects the *relayer*. The **client** independently re-derives the same operation list from its own inputs and refuses to sign if anything differs — throwing `SponsoredClaimMismatchError`. That is what stops a malicious relayer from redirecting the payout or appending an `AccountMerge` to steal the just-claimed token.

## The credit system

The relayer is metered so it isn't a free-for-all:

1. An app sends the relayer a normal XLM payment.
2. It calls `POST /credit/claim` with the **transaction hash**.
3. The relayer checks Horizon: the transaction succeeded, is sourced by that funding account, contains native payment ops **to the relayer** whose op-source is the funding account, and hasn't already been claimed. It sums every qualifying payment op and credits that amount.
4. From then on the relayer serves that app's requests, drawing the credit down.

Credit gating is switched on with **`RELAYER_REQUIRE_CREDIT=1`**.

### Proof of control

Fee-spending requests are authenticated by an **ed25519 challenge/response** (not an API key or HMAC):

1. `GET /credit/challenge?account=G...` returns a fresh random 32-byte nonce (120-second TTL, single-use, in-memory).
2. The client signs the canonical message with the funding account's key:

```text
shade-relayer:v1:{endpoint}:{fundingAccount}:{nonce}:{amount}[:{bind}]
```

3. The relayer verifies the signature, then **consumes** the nonce.

The signed message binds the endpoint, the account, the nonce, and the exact **amount** authorized. On `/relay`, `bind` is additionally the **inner transaction hash**, so an intercepted `{nonce, signature}` cannot be paired with a different inner XDR of the same fee.

### The ledger

A durable JSON file (default `./data/credit-ledger.json`, override with `CREDIT_LEDGER_PATH`):

- All arithmetic on **BigInt stroops** — never floats.
- **Atomic writes** (write-tmp + rename), so a crash mid-write can't corrupt it.
- **Per-account async locks**, so two concurrent reservations against a balance that only covers one cannot both succeed.
- **Reserve → settle / refund** around each submit: the fee is debited *before* submission, settled on success, refunded if the submit throws. Reservations carry a unique id and a terminal state (`OUTSTANDING` / `SETTLED` / `REFUNDED`) so a replay can't refund a legitimate charge.
- **Idempotent by ref** via O(1) net counters (debits minus refunds), so a duplicate is a no-op while a genuine retry after a refund still re-debits.
- Consumed deposit tx hashes make credit claims idempotent.
- Sponsored reserves are tracked in `sponsoredHeld` under a per-funder ceiling (`SPONSOR_CLAIM_MAX_HELD`).

## Rate limiting

A token bucket: **10 requests/minute per client**, `429` with `Retry-After` when empty.

Client identity comes from the direct IP by default. `X-Forwarded-For` is only trusted when you explicitly declare proxies via `TRUST_PROXY_HOPS`, and even then hops are counted **from the right** — the entries your own infrastructure appended — so a client cannot forge extra left-hand entries to mint a fresh bucket per request.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RELAYER_SECRET` | — | Relayer secret key. **If unset, a random keypair is generated** (unfunded) and logged. |
| `NETWORK` | `local` | `local` → standalone + `localhost:8000`; otherwise testnet |
| `PORT` | `3000` | Listen port |
| `RELAYER_REQUIRE_CREDIT` | `0` | `1` → require prepaid credit for `/relay` and `/sponsor-claim/submit` |
| `CREDIT_LEDGER_PATH` | `./data/credit-ledger.json` | Ledger file path |
| `TRUST_PROXY_HOPS` | `0` | Trusted reverse-proxy hops, counted from the right |
| `TRUST_PROXY` | — | Legacy: `true` → 1 hop |
| `SPONSOR_MAX_XLM` | `5` | Cap on `/sponsor` starting balance |
| `SPONSOR_CLAIM_MAX_HELD` | `10` | Per-funder sponsored-reserve ceiling |
| `MAX_RELAY_OPS` | `5` | Max ops in a relayed inner tx |
| `MAX_BASE_FEE` | `10000` | Clamp on the fetched base fee (stroops) |
| `MAX_RELAY_FEE_XLM` | `0.1` | Absolute outer fee cap |
| `MAX_RELAY_TIMEBOUNDS_SECONDS` | `600` | Max future window for the inner tx `maxTime` |
| `CORS_ORIGIN` | `*` | Allowed origin |
| `DEBUG` | — | Enable debug logs |

## Running it

```bash
RELAYER_SECRET=S... npx tsx packages/relayer/src/index.ts
# or from the repo root:
npm run relayer:dev
```

### Railway (testnet)

The relayer ships ready for Railway (`packages/relayer/railway.json`: NIXPACKS build, `npm run start` → `node dist/index.js`, health check on `/health`).

1. Fund a testnet account via friendbot
2. Set `RELAYER_SECRET` to its secret and `NETWORK=testnet`
3. Point Railway's root at `packages/relayer`
4. Deploy and hit `/health`

Step-by-step lives in `packages/relayer/README.md`.

## Operational warnings

Read these before running a relayer with real value:

1. **The default configuration is unauthenticated.** With `RELAYER_REQUIRE_CREDIT=0` (the shipped default), `/relay` and `/sponsor-claim/submit` perform **no authentication** — anyone can make the relayer pay fees (and front ~1 XLM reserves) for any conforming transaction, bounded only by an in-memory per-IP rate limit. Across many IPs this is a hot-wallet drain vector. **Set `RELAYER_REQUIRE_CREDIT=1` for any deployment that holds meaningful funds.** (`/sponsor` is fail-closed and always authenticated.)
2. **The ledger file is not durable on ephemeral filesystems.** On Railway, a redeploy or restart wipes credit balances *and* the consumed-tx records — meaning a previously claimed deposit could be re-claimed afterwards. Fine for a testnet demo; a durable store (Postgres/Redis) is the production fix and is on the roadmap.
3. **Challenge nonces and rate-limit buckets are in-memory and single-node.** Horizontal scaling breaks both the rate limit and the single-use nonce guarantee; a restart invalidates all outstanding nonces.
4. **`/sponsor-claim/prepare` is unauthenticated** and performs 2–3 Horizon lookups per call — a cheap amplification surface, protected only by the rate limit.
5. **`CORS_ORIGIN` defaults to `*`**, and an unset `RELAYER_SECRET` silently boots an unfunded random keypair rather than failing fast.

---

## Next steps

- [Delivery Methods](./04-delivery-methods.md) — when a claim needs the relayer
- [SDK Reference](./07-sdk-reference.md#relayerclient) — the typed `RelayerClient`
- [Security](./09-security.md) — the relayer's place in the threat model
- [FAQ & Troubleshooting](./10-faq-troubleshooting.md) — relayer errors
