#!/usr/bin/env bash
# Integration test harness: spins up a throwaway Postgres container, points the
# backend-parameterized store suite at it via TEST_DATABASE_URL, runs the full
# indexer suite (so the Postgres cases run instead of skipping), then tears the
# container down.
#
# Requires Docker. To run the SAME suite against a real cloud instance instead,
# skip this script and just export TEST_DATABASE_URL yourself:
#   TEST_DATABASE_URL=... npm test -w packages/indexer
# (env-only switch — no code change).
set -euo pipefail

# Run from the indexer package root regardless of caller cwd.
cd "$(dirname "$0")/.."

PG_NAME=shade-it-indexer-pg
PG_PORT=${PG_PORT:-55434}

cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "[integration] starting postgres:16-alpine on :$PG_PORT"
docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD=test -p "$PG_PORT:5432" postgres:16-alpine >/dev/null

echo "[integration] waiting for readiness..."
for _ in $(seq 1 30); do
  if docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

export TEST_DATABASE_URL="postgres://postgres:test@localhost:$PG_PORT/postgres"

echo "[integration] running indexer suite against live Postgres"
npx vitest run
