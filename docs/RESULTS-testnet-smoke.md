# Testnet E2E Smoke — Phase 1 (post-audit: local removal + B-list + A5)

Date: 2026-07-17 · Network: testnet (SDF).
Worked testnet smoke-flow evidence for the post-audit changes (the earlier run's
notes were session-temporary and not committed).
Contract redeployed because SH-3 changed the withdraw preimage (consensus-breaking).

## Environment
- Contract id: `CDQBZZ5B2GUE7RG6NDWLZYE7TLSQAEZODGRO565GKAHN73C2SGVG76BX` (deploy.sh --network testnet → `~/.stealth/testnet-contract`). Ephemeral; not pinned in docs.
- Relayer: funded `RELAYER_SECRET` (GD6Q…MIBC), credit gating ON by DEFAULT (no `RELAYER_REQUIRE_CREDIT` set), JSON ledger on a temp path, port 3477.
- Keys: deployer, feepayer (F, also the credit funding account), relayer (RL), recipient keystore (plaintext), fresh destinations bobdest (direct) + e2e-dest (D, relayed).

## Matrix

| Step | Result | Evidence |
|---|---|---|
| deploy contract (fresh, SH-3 preimage) | PASS | id above; deploy.sh testnet-only path |
| relayer boot WITHOUT `RELAYER_SECRET` | PASS (exit 1) | "RELAYER_SECRET is required (there is no dev fallback)" — the `Keypair.random()` dev fallback is gone |
| relayer boot WITH funded secret | PASS | startup log `Credit gating resolved {requireCredit:true, reason:"default (credit gating is always on…)"}` — secure-by-default holds after the `local` removal |
| `/health` | PASS | `{status:ok, network:testnet, requireCredit:true, maxRelayFeeXlm:0.1}` (new fee-ceiling field) |
| keygen (plaintext) + `address` roundtrip | PASS | same meta-address re-printed with no password |
| pool send 100 XLM | PASS | tx `fdb0177f…5294f`, stealth `GDHQFR2M…IWBJ` |
| pool scan (`--verbose`) | PASS | verbose shows per-page counts + phase timings; found the 100 XLM pool payment. Account phase walked the feed in ~69s (pre-indexer; A4) |
| `shade balance` (A4-P0 cursor reuse) | PASS, ~1.6s | warm balance reuses the persisted cursor instead of re-walking the feed (audit had it hang >3.5 min) |
| pool DIRECT withdraw 40 XLM (fee-payer) | PASS | tx `4e54e7e6…8001`, landed at bobdest. Proves the **SH-3 preimage + StealthScalar signing validate on-chain against the fresh contract** |
| pool relayed withdraw, UNCREDITED | PASS (rejected) | CLI without funding auth → "Funding account required"; a signed-but-uncredited path → 402 |
| pool relayed withdraw, CREDITED (SDK, challenge auth + `confirm:true`) | PASS | credit deposit `da16f9a6…1a13` → creditClaim (5.0) → relayed withdraw 60 XLM tx `4db441d7…abcb`; credit debited 5.0000000 → 4.9968569 (actual fee only); `confirm:true` polled the hash on-chain without throwing |
| USDC / classic-SAC pool path | NOT RUN this pass | unchanged by Phase 1; covered in the prior audit matrix |
| account send/claim | NOT RUN this pass | discovery is the A4 indexer's scope; account send/claim logic unchanged |

## SDK-POOLRELAY-PRIV — testnet finding (decision: DOCUMENT, do not mitigate now)
Inspected the credited relayed withdraw `4db441d7…abcb` on Horizon:
- `fee_account` (pays the fee) = **RL, the relayer** — the fee-bump hides who funds the fee. ✓
- inner `source_account` (authors the withdraw) = **F, the user's fee-payer** (`GCDRIFIH…3ZAW`).
- destination D sees the payout as an `invoke_host_function` (contract-mediated; no classic `from`), but the **transaction's inner source is F and is publicly visible**.

Conclusion: for the **pool** method a relayed withdraw hides *who pays the fee*, not *who authored the inner tx*. The pool withdraw structurally needs a funded inner source (sequence + Soroban resource fee), and making the relayer that source is the sponsor-claim flow — a large, different change, **not** a small SDK edit. Per the plan's decision rule this is outcome (b): **document accurately** rather than mitigate. The README/docs privacy wording must say: pool relay = fee-payer privacy, not inner-author unlinkability; use a throwaway funded fee-payer per withdraw, or the account sponsored-claim path, when inner-author unlinkability matters. (Docs edit lands in the separate docs commit.)

## Follow-up found at the gate (noted, not in Phase 1 scope)
The **account** method's relayed submit (`methods/account.ts` `submit()`) builds `new RelayerClient(relay)` with no `fundingSigner`, so it attaches no proof-of-control. Against a credit-gated relayer (now the default) account claims would 402. Pool withdraw is fixed (fundingSigner threaded); the account path needs the same wiring — file under the A3/relayer follow-ups.

## Gate-driven code changes (committed this pass)
- `34977fc` thread `fundingSigner` + `confirm` through the pool withdraw relay path (was: fundingAccount only → 402 missing_auth).
- `f401b49` sign a fee **ceiling** (`authAmount`, defaulted from `/health` `maxRelayFeeXlm`) for `/relay` credit auth, not the unpredictable exact fee (was → 401 invalid_signature); relayer enforces actual ≤ ceiling and reserves the actual fee.

---

# Phase 2 E2E — A2 durable + shared relayer (Postgres + Redis)

Date: 2026-07-17. Relayer booted with `DATABASE_URL` (Postgres 16) + `REDIS_URL` (Redis 7) via `docker run`; funded `RELAYER_SECRET`, credit gating ON by default.

| Step | Result | Evidence |
|---|---|---|
| relayer boot on Postgres+Redis | PASS | startup logs "Credit ledger backend: Postgres", "Shared state backend: Redis"; `/health` → `store:postgres, sharedState:redis` |
| fail-fast: `REDIS_URL` set but unreachable | PASS (exit 1) | "REDIS_URL is set but Redis is unreachable" — no silent fallback to memory (gate found + fixed a lazy-connect/ping timing bug here) |
| unit suite WITHOUT backend env | PASS | 126 passed + 54 skipped (backend tests skip gracefully) |
| integration suite WITH dockerized pg+redis | PASS | `npm run test:integration` → 180 passed / 12 files (Postgres ledger spec, Redis nonce/rate, cross-instance) |
| cross-instance ledger (2 live PostgresCreditLedger, 1 DB) | PASS | credit visible across instances; DB-enforced deposit idempotency; concurrent one-fee-balance reserve → exactly one debits; reservation opened on A settled on B |
| money path on pg+redis: credit → gated relayed withdraw | PASS | deposit `0abdbd77…`, creditClaim 5.0, relayed withdraw 50 XLM tx `1c231f85…`, credit debited to 4.9543374 (reserve/settle in Postgres, nonce in Redis) |
| **RESTART DURABILITY** | PASS | after killing + restarting the relayer: `/credit/:account` still reports 4.9543374 (survived from Postgres), and re-claiming the consumed deposit → **409 tx_already_claimed** — the exact F11 re-credit-after-restart hole is closed (the old JSON-on-ephemeral-FS ledger lost both) |

**Verdict:** the relayer is durable (credit + idempotency + reservations survive restarts) and multi-instance (two instances share credit ledger, nonces, and rate-limit buckets over one Postgres + one Redis). The JSON-file + in-memory path remains as a zero-config dev fallback; switching to owner-provided Neon/Upstash URLs is env-only (`DATABASE_URL`/`REDIS_URL`), no code change.
