---
title: Relayer
description: "The Shade relayer: fee-bumping, sponsored claims and the credit system. Endpoints, proof-of-control auth, configuration and operational warnings."
---

# The Shade Relayer

The relayer is the reference service (`packages/relayer`) that an app or community runs. It solves a chicken-and-egg problem: to claim your money you'd normally need a funded Stellar account to pay the fee, but *using* a funded account links it to you, undoing the privacy.

This page covers what it does, its endpoints, the credit system, configuration, and deployment.

---

## What it solves

- **Fee-bump** (`/relay`): the relayer pays your withdrawal's fee, so you never reveal a funded account of your own. This is purely about **privacy**. The relayer sees the transaction envelope but learns nothing about your other accounts.
- **Reserve fronting / sponsored claims** (`/sponsor`, `/sponsor-claim/*`): it fronts the ~1 XLM account reserve (plus ~0.5 XLM trustline reserve for tokens) so you can cash out to a **fresh, unfunded address**.

> **There is no hosted or hard-coded relayer URL.** "Default" only ever means the reference service *you* deploy and point your app at. The relayer is standalone: it has no dependency on `@shade/crypto`.

## Choosing a relayer

Apps and users can hand the SDK/CLI **several** relayer URLs instead of one (`ClientConfig.relayer: string[]`, CLI `--relay a,b` or the `SHADE_RELAYERS` env var). The client then health-probes every candidate in parallel and routes each relayed submission to a healthy one, failing over on relayer faults. See [SDK Reference → RelayerPool](./07-sdk-reference.md#relayerpool) for the exact health rule and failover semantics. A candidate counts as healthy only when its `/health` reports `status: 'ok'` on the right network with a workable balance, **and** its credit gate is passable by this caller. This is where the `store`/`sharedState` fields also let a client prefer a durable (`postgres`/`redis`) deployment over a dev-fallback one.

Selection among healthy candidates is **random by default**. That is deliberate, so a community's users spread across its relayer set instead of herding onto the first entry.

> **Privacy: which relayer you use matters.** A relayer's value is partly its **anonymity set**: a shared relayer fee-bumps many users' transactions, so any one of them blends into the crowd. Running a **personal** relayer inverts that. Its funded account pays fees for exactly one person, and its funding trail links straight back to you, tagging every transaction it touches as yours. Prefer **per-dApp or community relayers** with many users, and treat a personal relayer as a convenience for testing, not a privacy tool.

**Credit is per-relayer.** A funding account's prepaid credit lives in one relayer's ledger. If you list several independent relayers, fund your account at each of them. A failover target where you hold no credit rejects with `402 insufficient_credit` (and the client correctly stops rather than retrying elsewhere).

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /health` | Status, network, relayer address, balance, `requireCredit`, `maxRelayFeeXlm`, `sponsoredReserveEstimate`, `store` (`postgres`\|`json`), `sharedState` (`redis`\|`memory`) |
| `POST /relay` | Fee-bump and submit a signed transaction |
| `POST /sponsor` | Create a stealth account (funded `CreateAccount` from the relayer) |
| `POST /sponsor-claim/prepare` | Build an unsigned sponsored-claim transaction |
| `POST /sponsor-claim/submit` | Co-sign + submit a sponsored claim |
| `POST /credit/claim` | Top up credit by proving an XLM payment via `txHash` |
| `GET /credit/challenge` | Issue a proof-of-control nonce |
| `GET /credit/:account` | Read a credit balance |

### `POST /relay`

Body: `{ xdr, fundingAccount?, nonce?, signature?, authAmount? }` → `{ txHash, success: true }`

Wraps your signed inner transaction in a fee-bump and submits it.

> **What a relayed POOL withdraw actually hides.** The relayer fee-bumps the transaction, so it hides **who pays the fee**, not who *authored* the withdraw. On the pool path the fee-payer account you pass is the inner transaction's on-chain `source_account`, and that is **publicly visible**. So pool relay gives you **fee-payer privacy, not inner-author unlinkability**. If author unlinkability matters, use a **throwaway funded fee-payer per withdraw**, or the account method's **sponsored-claim** flow (where the relayer itself is the inner source). Relaying stays **trustless** regardless: the withdraw signature binds destination + amount + contract + network, so a relayer cannot redirect or tamper with the withdrawal.

Abuse guards apply on **every** path, credit-gated or not:

| Guard | Default |
|---|---|
| Max operations in the inner tx | 5 (`MAX_RELAY_OPS`); zero-op inner txs are rejected (`invalid_tx`) |
| Timebounds must be present, unexpired, and bounded | ≤ now + 600s (`MAX_RELAY_TIMEBOUNDS_SECONDS`); already-expired bounds are rejected up front (`invalid_timebounds`) rather than burning a submit |
| Memos | **Forbidden** (a relayed withdrawal has no legitimate memo, and one could leak or tag metadata) |
| Fetched base fee clamp | 10,000 stroops (`MAX_BASE_FEE`) |
| Absolute outer fee cap | 0.1 XLM (`MAX_RELAY_FEE_XLM`) |

The outer-fee cap is enforced **before** the fee bump is built. The relayer plans the bump fee from the inner tx's own per-op demand (excluding any Soroban resource fee), so an inner fee large enough to push the outer fee over the cap gets an honest `400 fee_exceeds_cap`, while a high-but-cappable inner fee is served with a correspondingly raised bump fee. An inner tx the SDK cannot build a fee bump for at all returns `400 invalid_tx`.

**What you're charged.** The fee is *reserved* at the built maximum (the fee bid must be covered before submission) and *settled* to the on-chain **`fee_charged`** decoded from the submit result. The difference, including Soroban resource-fee refunds on contract withdrawals, is credited back automatically in the same atomic step. Your credit history shows the full-bid debit followed by an `adjust:`-tagged credit for the refund.

### `POST /sponsor`

Body: `{ address, startingBalance?, fundingAccount, nonce, signature }` → `{ txHash, stealthAddress }`

Creates a stealth account with a plain funded `CreateAccount`. **Fail-closed by design:** this route *always* requires an authenticated funding account and *always* debits `startingBalance + fee` from its credit, regardless of `RELAYER_REQUIRE_CREDIT`, so it can never be used as a free XLM faucet. `startingBalance` is capped at `SPONSOR_MAX_XLM` (default 5).

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

The charge is `sponsoredReserveEstimate` plus the transaction fee. The fee portion, like `/relay`'s, is settled to the on-chain **`fee_charged`** rather than the declared maximum. The reserve portion stays charged in full: it tracks the base reserve the relayer actually locks on-chain, not a fee.

> **Two-sided verification.** The relayer's check protects the *relayer*. The **client** independently re-derives the same operation list from its own inputs and refuses to sign if anything differs, throwing `SponsoredClaimMismatchError`. That is what stops a malicious relayer from redirecting the payout or appending an `AccountMerge` to steal the just-claimed token.

## The credit system

The relayer is metered so it isn't a free-for-all:

1. An app sends the relayer a normal XLM payment.
2. It calls `POST /credit/claim` with the **transaction hash**.
3. The relayer checks Horizon: the transaction succeeded, is sourced by that funding account, contains native payment ops **to the relayer** whose op-source is the funding account, and hasn't already been claimed. It sums every qualifying payment op and credits that amount. (A malformed funding account is rejected with `invalid_account`, the same code the challenge endpoint uses.)
4. From then on the relayer serves that app's requests, drawing the credit down.

Credit gating is **on by default on every network**, so an unconfigured deploy cannot be drained through unauthenticated `/relay` and `/sponsor-claim/submit` calls. Set **`RELAYER_REQUIRE_CREDIT=0`** to disable it or **`=1`** to force it on explicitly.

### Proof of control

Fee-spending requests are authenticated by an **ed25519 challenge/response** (not an API key or HMAC):

1. `GET /credit/challenge?account=G...` returns a fresh random 32-byte nonce (120-second TTL, single-use, in-memory).
2. The client signs the canonical message with the funding account's key:

```text
shade-relayer:v1:{endpoint}:{fundingAccount}:{nonce}:{amount}[:{bind}]
```

3. The relayer verifies the signature, then **consumes** the nonce.

The signed message binds the endpoint, the account, the nonce, and the exact **amount** authorized. On `/relay` the client sends that amount in the request body as `authAmount`, and `bind` is additionally the **inner transaction hash**, so an intercepted `{nonce, signature}` cannot be paired with a different inner XDR of the same fee.

On `/relay` the signed `authAmount` is a **fee ceiling**: the client authorizes "debit up to the relayer's advertised `maxRelayFeeXlm` for THIS inner tx", and the relayer debits only the **actual** fee (reserved at the built bid, settled down to the on-chain `fee_charged`), rejecting anything above the ceiling with `fee_exceeds_authorization`. On `/sponsor-claim/submit` the amount is the **exact** total the relayer will charge: the prepared tx's fee plus the sponsored-reserve estimate. That reserve component is advertised in `/health` as **`sponsoredReserveEstimate`** (`'1.0000000'`). Clients prefer the advertised value over their own mirrored constant when computing the total they sign, so changing the estimate relayer-side no longer breaks gated sponsored claims, and a `/health` fault just falls back to the mirrored constant, never breaking the claim itself.

The SDK and CLI handle all of this automatically once they hold a funding signer:

```bash
# CLI: the funding secret signs the challenge (prefer the env var over the flag)
SHADE_FUNDING_SECRET=S... shade claim <stealth> <dest> --relay https://relayer.example
```

```typescript
// SDK: any FundingSigner works — a raw key, a wallet, an HSM
await client.claim(payment, dest, {
  keys,
  relay: 'https://relayer.example',
  fundingAccount: 'G...',                        // account whose credit is debited
  fundingSigner: (msg) => kp.sign(Buffer.from(msg)),  // proof of control
});
```

### The ledger

The credit ledger holds balances, consumed-deposit idempotency records, reservations, and per-funder sponsored-reserve totals. Whichever backend is in use (JSON file or Postgres, below), the accounting semantics are the same:

- All arithmetic on **BigInt stroops**, never floats.
- **Concurrency-safe** reservations, so two concurrent holds against a balance that only covers one cannot both succeed (per-account async locks for the JSON file; row-level guarantees for Postgres).
- **Reserve → settle / refund** around each submit: the fee is debited *before* submission, settled on success, refunded if the submit throws. Reservations carry a unique id and a terminal state (`OUTSTANDING` / `SETTLED` / `REFUNDED`) so a replay can't refund a legitimate charge.
- **Settle reconciles to the actual charge**: settle accepts the on-chain `fee_charged`, keeps `actual ≤ reserved`, and credits the remainder back in the same atomic step (an `adjust:`-tagged history credit). Still idempotent: only an `OUTSTANDING` reservation flips, exactly once, so a replay can't double-credit the remainder. If the submit result can't be parsed, the full reserved amount is settled (the pre-reconciliation behavior) rather than ever failing a landed transaction.
- **Idempotent by ref** via O(1) net counters (debits minus refunds), so a duplicate is a no-op while a genuine retry after a refund still re-debits.
- Consumed deposit tx hashes make credit claims idempotent.
- Sponsored reserves are tracked under a per-funder ceiling (`SPONSOR_CLAIM_MAX_HELD`).

The **JSON-file backend** (default `./data/credit-ledger.json`, override with `CREDIT_LEDGER_PATH`) is the single-instance dev fallback, used only when `DATABASE_URL` is unset. It uses **atomic writes** (write-tmp + rename) so a crash mid-write can't corrupt it, but it lives on local disk: on an ephemeral filesystem a restart wipes it (see the warning below). For any real deploy, use Postgres.

## Durable & multi-instance state

The JSON ledger plus in-memory nonces/rate-limits are fine for a single dev instance, but they don't survive a restart on an ephemeral filesystem and can't be shared across instances. Two optional env vars swap in durable, shared backends. **Both fail fast (exit 1) if set but unreachable.** The relayer never silently falls back, because a configured deploy that quietly forks its money ledger onto ephemeral local disk is worse than not starting.

| Variable | Backs | Provider example |
|---|---|---|
| `DATABASE_URL` | The **credit ledger** (balances, consumed-deposit idempotency, reservations), durable across restarts and shared across instances | Postgres (Neon / Supabase free tier); pass the **pooled** URL with `sslmode=require` |
| `REDIS_URL` | **Challenge nonces + rate-limit buckets** shared fleet-wide (a nonce is single-use across the whole fleet; one rate bucket per client) | Redis (Upstash); `rediss://` URL |
| `PGPOOL_MAX` | Max Postgres pool connections (free tiers cap low) | default `5` |

- **`DATABASE_URL` (Postgres).** The schema **auto-migrates on boot** (or run `npm run migrate`). A background **reservation-recovery job** refunds stale `OUTSTANDING` holds so a crash between reserve and settle can't strand credit. Unset → the JSON-file ledger above.
- **`REDIS_URL` (Redis).** With Redis, nonce single-use and the rate limit hold across every instance. Unset → in-process memory (single instance only).
- **`store` / `sharedState` in `/health`** report which backend is live (`postgres`\|`json`, `redis`\|`memory`) so a client can prefer a durable, multi-instance relayer.

Unset both and you get the JSON-file ledger plus in-memory nonces/limits, a fine single-instance dev fallback. The ephemeral-filesystem warning still fires when credit gating is on.

## Rate limiting

A token bucket: **10 requests/minute per client**, `429` with `Retry-After` when empty.

Client identity comes from the direct IP by default. `X-Forwarded-For` is only trusted when you explicitly declare proxies via `TRUST_PROXY_HOPS`, and even then hops are counted **from the right** (the entries your own infrastructure appended), so a client cannot forge extra left-hand entries to mint a fresh bucket per request.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RELAYER_SECRET` | — | Relayer secret key (`S...` of a funded account). **ALWAYS REQUIRED**: the relayer fails fast (exit 1) if unset/empty. There is no dev fallback: a randomly generated keypair is unfunded and can't pay fees. |
| `NETWORK` | `testnet` | Target network. Defaults to `testnet`; **rejects unknown values (incl. the removed `local`)** with exit 1. Mainnet (`public`) is added post-audit. |
| `PORT` | `3000` | Listen port |
| `RELAYER_REQUIRE_CREDIT` | on (all networks) | Require prepaid credit for `/relay` and `/sponsor-claim/submit`. **On by default on every network**; set `0` to disable, `1` to force on. |
| `DATABASE_URL` | — | Postgres URL (pooled, `sslmode=require`) backing the **credit ledger**, durable + shared across instances. Auto-migrates on boot. Set-but-unreachable → exit 1 (never a silent JSON fallback). Unset → JSON-file ledger. |
| `REDIS_URL` | — | Redis (`rediss://`) URL backing **challenge nonces + rate-limit buckets** shared fleet-wide. Set-but-unreachable → exit 1. Unset → in-memory (single instance). |
| `PGPOOL_MAX` | `5` | Max Postgres pool connections (free tiers cap low) |
| `CREDIT_LEDGER_PATH` | `./data/credit-ledger.json` | JSON-ledger file path (dev fallback; used only when `DATABASE_URL` is unset). **Point at a mounted persistent volume**: the default is ephemeral on Railway (see warning below). |
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

1. **Authentication is on by default on every network.** `/relay` and `/sponsor-claim/submit` require credit whenever `RELAYER_REQUIRE_CREDIT` is unset (it defaults on). If you explicitly set `RELAYER_REQUIRE_CREDIT=0` on a funded deployment, those endpoints perform **no authentication**: anyone can make the relayer pay fees (and front ~1 XLM reserves) for any conforming transaction, bounded only by an in-memory per-IP rate limit, which across many IPs is a hot-wallet drain vector. **Do not disable credit on a deployment that holds meaningful funds.** (`/sponsor` is fail-closed and always authenticated.)
2. **The JSON ledger file is not durable on ephemeral filesystems.** When you use the JSON fallback (`DATABASE_URL` unset), a Railway redeploy or restart wipes credit balances *and* the consumed-tx records, meaning a previously claimed deposit could be re-claimed afterwards. The relayer **warns loudly at startup** when credit is enabled and `CREDIT_LEDGER_PATH` looks ephemeral (unset or under `./data`). Point it at a mounted persistent volume, or (the full production fix) set `DATABASE_URL` for a durable Postgres ledger (see [Durable & multi-instance state](#durable--multi-instance-state)).
3. **In-memory nonces and rate-limit buckets are single-node.** Without `REDIS_URL`, horizontal scaling breaks both the rate limit and the single-use nonce guarantee, and a restart invalidates all outstanding nonces. Set `REDIS_URL` to share both fleet-wide.
4. **`/sponsor-claim/prepare` is unauthenticated** and performs 2–3 Horizon lookups per call, a cheap amplification surface protected only by the rate limit.
5. **`CORS_ORIGIN` defaults to `*`.** The relayer warns at startup whenever it is `*`; set it to your app origin. And **`RELAYER_SECRET` is always required**: the relayer fails fast (exit 1) if it is unset/empty, rather than ever booting an unfunded random keypair.

---

## Next steps

- [Delivery Methods](./04-delivery-methods.md) — when a claim needs the relayer
- [SDK Reference](./07-sdk-reference.md#relayerclient) — the typed `RelayerClient`
- [Security](./09-security.md) — the relayer's place in the threat model
- [FAQ & Troubleshooting](./10-faq-troubleshooting.md) — relayer errors
