# @shade/relayer

HTTP service that fee-bumps stealth-withdrawal transactions and sponsors
stealth-account creation on Stellar. It breaks the sender→recipient on-chain
link so recipients don't need a pre-funded account to pay fees.

The relayer has **no `@shade/crypto` dependency** — it builds and runs
standalone.

## Endpoints

- `GET  /health`                  — status, network, relayer address, balance
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

### Roadmap caveat — ephemeral filesystem

Railway's filesystem is ephemeral, so the JSON credit ledger
(`CREDIT_LEDGER_PATH`) does **NOT** survive restarts/redeploys — acceptable for a
testnet demo, but a durable store (Postgres/Redis) is the production fix.
