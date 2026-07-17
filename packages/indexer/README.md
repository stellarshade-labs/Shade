# @shade/indexer

HTTP service that indexes Shade announcement candidates from the Horizon
transaction feed and serves them as a compact, Horizon-interchangeable feed.

Shade's account delivery method publishes **no view tag**: the transaction's
MemoHash **is** the ephemeral pubkey R. Discovery therefore has to walk the
global Horizon transaction feed client-side — minutes for a cold scan. The
indexer moves that walk server-side, **once for everyone**: it ingests the
feed, keeps ONLY hash-memo transactions with their operations, and serves a
compact candidate feed the client filters locally.

It deliberately has **no address- or R-keyed query** — such a query would let
the operator link keys to requests. Trust model: the indexer can *hide*
payments (an availability failure) but cannot *fabricate* them — clients derive
the stealth address from R and re-verify on-chain at claim. Horizon stays the
source of truth; cursors are Horizon `paging_token`s, so indexer and Horizon
cursors are interchangeable.

The indexer has **no `@shade/sdk` or `@stellar/stellar-sdk` dependency** — it
builds and runs standalone.

## Endpoints

- `GET /announcements?cursor=&limit=` — hash-memo candidate records (Horizon
  transaction shape with `operations` inlined verbatim) strictly after
  `cursor`; the response `cursor` resumes paging, jumping to the indexer's
  global position once the feed is drained
- `GET /health` — status, network, store backend, ingest cursor/lag

## Configuration

All configuration is via environment variables — see [`.env.example`](./.env.example)
for the full list with defaults. Copy it to `.env` for local development:

```bash
cp .env.example .env
```

With `DATABASE_URL` unset the store is in-memory: announcements are lost on
restart and re-ingested from `INGEST_START`. Set `DATABASE_URL` (Postgres) for
a durable index; the schema auto-migrates on boot (or run `npm run migrate`).

## Local development

```bash
npm install
npm run dev              # tsx src/index.ts (hot TS)
npm test                 # vitest (Postgres cases skip without TEST_DATABASE_URL)
npm run test:integration # full suite against a throwaway dockerized Postgres
```

## Production build & run

```bash
npm run build    # tsc -> dist/
npm run start    # node dist/index.js
```
