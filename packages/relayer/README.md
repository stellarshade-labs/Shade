# @shade/relayer

HTTP service that fee-bumps stealth-withdrawal transactions and sponsors
stealth-account creation on Stellar. It breaks the sender→recipient on-chain
link so recipients don't need a pre-funded account to pay fees.

The relayer has **no `@shade/crypto` dependency** — it builds and runs
standalone.

## Endpoints

- `GET  /health`                  — status, network, relayer address, balance, `requireCredit`, `maxRelayFeeXlm`, `store` (`postgres`|`json`), `sharedState` (`redis`|`memory`)
- `POST /relay`                   — wrap a signed tx in a fee-bump and submit
- `POST /sponsor`                 — create a stealth account via sponsored reserves
- `POST /sponsor-claim/prepare`   — build a sponsored claim tx
- `POST /sponsor-claim/submit`    — co-sign + submit a sponsored claim
- `POST /credit/claim`            — credit an app account from a deposit
- `GET  /credit/challenge`        — issue a proof-of-control nonce
- `GET  /credit/:account`         — read an app account's credit balance

## Configuration

All configuration is via environment variables — see [`.env.example`](./.env.example)
for the full list with defaults. Copy it to `.env` for local development:

```bash
cp .env.example .env
```

Secure-by-default highlights:

- **`RELAYER_SECRET` is ALWAYS REQUIRED.** The relayer fails fast (exit 1) if it
  is unset/empty — there is no dev fallback, because a randomly generated keypair
  is unfunded and can never pay a fee. Set it to the secret (`S...`) of a funded
  account.
- **`NETWORK` defaults to `testnet`** and rejects unknown values (including the
  removed `local`) with exit 1. Mainnet (`public`) is added post-audit.
- **Credit gating is ON by default on every network.** Unauthenticated `/relay`
  and `/sponsor-claim/submit` would otherwise let anyone drain the hot wallet.
  Set `RELAYER_REQUIRE_CREDIT=0` to disable it, `=1` to force it on.
- For any real deploy, set **`DATABASE_URL`** and **`REDIS_URL`** — see
  [Durable & multi-instance state](#durable--multi-instance-state) below.

## Local development

```bash
npm install
npm run dev      # tsx src/index.ts (hot TS)
npm test         # vitest
```

## Production build & run

Railway (and any production deploy) runs the **compiled** output, not `tsx`:

```bash
npm run build    # tsc -> dist/
npm run start    # node dist/index.js
```

## Deploy to Railway (testnet)

1. **Fund a testnet relayer account.** Generate a Stellar keypair and fund it
   via friendbot:

   ```bash
   curl "https://friendbot.stellar.org/?addr=<G...PUBLIC_KEY>"
   ```

2. **Configure the service.** In Railway, point the project's **root directory**
   at `packages/relayer`, and set these variables:

   - `RELAYER_SECRET` — the funded testnet account's secret (`S...`)
   - `NETWORK=testnet`
   - `TRUST_PROXY_HOPS=1` — Railway sits behind one edge proxy

   Railway injects `PORT` automatically; the health check uses `/health`.

3. **Deploy.** Railway's NIXPACKS builder runs `npm install && npm run build`,
   then `npm run start` (`node dist/index.js`). The deploy descriptor lives in
   [`railway.json`](./railway.json).

4. **Verify.** Once live, `GET /health` on the service URL returns `200` with a
   JSON body reporting `status: "ok"`, the network, the relayer address, and its
   XLM balance.

## Durable & multi-instance state

By default the relayer keeps its credit ledger in a JSON file
(`CREDIT_LEDGER_PATH`) and its challenge nonces + rate-limit buckets in memory.
That is fine for a single dev instance, but the JSON file does **NOT** survive
restarts/redeploys on Railway's ephemeral filesystem, and neither backend is
shared across instances. Two optional env vars swap in durable, shared stores.

**Both fail fast (exit 1) if set but unreachable** — the relayer never silently
falls back, because a configured deploy that quietly forks its money ledger onto
ephemeral local disk is worse than not starting.

| Variable | Backs | Provider example |
|---|---|---|
| `DATABASE_URL` | The **credit ledger** (balances, consumed-deposit idempotency, reservations) — durable across restarts, shared across instances | Postgres (Neon / Supabase free tier); pass the **pooled** URL with `sslmode=require` |
| `REDIS_URL` | **Challenge nonces + rate-limit buckets** shared fleet-wide (a nonce is single-use across the whole fleet; one rate bucket per client) | Redis (Upstash); `rediss://` URL |
| `PGPOOL_MAX` | Max Postgres pool connections (free tiers cap low) | default `5` |

- **`DATABASE_URL` (Postgres).** The schema **auto-migrates on boot**, or run
  `npm run migrate`. A background **reservation-recovery job** refunds stale
  `OUTSTANDING` holds so a crash between reserve and settle can't strand credit.
  Unset → the JSON-file ledger (the ephemeral-filesystem warning still fires when
  credit gating is on).
- **`REDIS_URL` (Redis).** Unset → in-process memory (single instance only);
  horizontal scaling then breaks the single-use nonce guarantee and the rate
  limit.

`/health` reports the live backends as `store` (`postgres`|`json`) and
`sharedState` (`redis`|`memory`).
