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
  global position once the feed is drained. Records carry the transaction's
  `source_account` (rows ingested before the field existed omit it), which
  lets the SDK bind token claimable balances sponsor-precisely without a
  per-tx Horizon round-trip
- `GET /health` — status, network, store backend, ingest cursor/lag, recorded
  feed `gaps`, and the ingest flags (`resetSuspected`, `continuityStale`,
  `stalled`, `lastContinuityOkAt`). `status` is `degraded` whenever coverage
  has a hole, a testnet reset is suspected, the continuity check is not
  succeeding, or ingestion has stalled — SDK scan guards require `ok`, so a
  degraded indexer is skipped automatically and Horizon covers correctness

Both endpoints are rate limited per client IP (`429` + `Retry-After` when
exceeded) — see Operations below.

## Configuration

All configuration is via environment variables — see [`.env.example`](./.env.example)
for the full list with defaults. Copy it to `.env` for local development:

```bash
cp .env.example .env
```

With `DATABASE_URL` unset the store is in-memory: announcements are lost on
restart and re-ingested from `INGEST_START`. Set `DATABASE_URL` (Postgres) for
a durable index; the schema auto-migrates on boot (or run `npm run migrate`).

## Operations

**Run it from your deployment epoch.** The default `INGEST_START=now` starts
coverage at boot; payments sent before your start cursor are outside coverage
by design (clients discover them with an exhaustive scan). Starting at
`genesis` only helps if your Horizon still retains that history.

**Feed continuity.** At boot and every `GAP_CHECK_INTERVAL_MS` (default 10
min) the ingester compares its cursor against Horizon's retention window. If
Horizon dropped ledgers before they were ingested (the indexer was down past
the retention horizon), the hole — including the cursor ledger itself, whose
tail may be partially unserved — is recorded permanently, surfaced in
`/health` as `gaps`, and `status` flips to `degraded` — clients then skip the
indexer and fall back to Horizon, so a hole can never hide a payment.

Because a recorded gap is permanent, the check fails **closed** in every
direction: ingestion never starts before the process's first successful
check; bounds from a root document reporting a different network passphrase
(a mistyped `HORIZON_URL`) are discarded; and a hole is recorded only after
two consecutive observations, with paging paused in between. A persistently
failing check (e.g. a proxy that breaks only Horizon's `/` root path)
surfaces as `ingest.continuityStale` and degrades `/health` rather than
silently disabling the feature. A frozen ingest loop likewise surfaces as
`ingest.stalled` and degrades.

Recovery from a REAL gap: wipe the database and re-ingest from a covered
position. If a false gap ever gets recorded despite the guards, the surgical
remedy is deleting its row (`DELETE FROM ingest_gaps WHERE from_ledger = …`)
— do this only when certain the range was actually ingested.

**Testnet resets.** Stellar's testnet resets quarterly. A stale database then
holds announcements from the previous chain era; the continuity check flags
this on two consecutive observations (`ingest.resetSuspected`,
`status: degraded`, loud error logs) and the flag LATCHES — the new chain
growing past the old cursor height does not clear it. Remedy: wipe the
database (or point `DATABASE_URL` at a fresh one) and restart. Caveat: a
restart so late that the new chain has already outgrown the stale cursor
(many months of downtime) is not detectable from retention bounds alone —
after any reset, wipe before redeploying.

**Staleness.** `/health.lagSeconds` reports how far ingestion trails the
network head. Correctness never depends on it (client scans always finish
with a Horizon tail), but the SDK skips indexers lagging beyond its
`indexerMaxLagSeconds` (default 6 h) as operationally abandoned.

**Rate limits.** Per-IP token buckets: `ANNOUNCEMENTS_RPM` (default 600 — a
cold scan pages the feed in a burst and gets no second chance mid-scan) and
`HEALTH_RPM` (default 120), answering `429` with a `Retry-After` reporting
the real remaining wait. Limits are per instance (no shared state); tracked
buckets are capped, with overflow clients sharing one backstop bucket.
Behind a reverse proxy set `TRUST_PROXY_HOPS` so clients are keyed by the
rightmost non-forgeable `X-Forwarded-For` entry (values that do not parse as
an IP fall back to the socket address); otherwise the header is ignored.
When hops are trusted, the origin port must be reachable only through the
proxy chain — a directly-reachable origin lets clients choose their own
bucket by forging the header.

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
