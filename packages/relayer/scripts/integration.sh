#!/usr/bin/env bash
# Integration test harness: spins up throwaway Postgres + Redis containers,
# points the backend-parameterized suites at them via TEST_DATABASE_URL /
# TEST_REDIS_URL, runs the full relayer suite (so the Postgres/Redis + cross-
# instance cases run instead of skipping), then tears the containers down.
#
# Requires Docker. To run the SAME suites against real cloud instances instead,
# skip this script and just export TEST_DATABASE_URL / TEST_REDIS_URL yourself:
#   TEST_DATABASE_URL=... TEST_REDIS_URL=... npm test -w packages/relayer
# (env-only switch — no code change).
set -euo pipefail

# Run from the relayer package root regardless of caller cwd.
cd "$(dirname "$0")/.."

PG_NAME=shade-it-pg
REDIS_NAME=shade-it-redis
PG_PORT=${PG_PORT:-55433}
REDIS_PORT=${REDIS_PORT:-56381}

cleanup() {
  docker rm -f "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "[integration] starting postgres:16-alpine on :$PG_PORT and redis:7-alpine on :$REDIS_PORT"
docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD=test -p "$PG_PORT:5432" postgres:16-alpine >/dev/null
docker run -d --name "$REDIS_NAME" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null

echo "[integration] waiting for readiness..."
for _ in $(seq 1 30); do
  if docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
for _ in $(seq 1 30); do
  if [ "$(docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null)" = "PONG" ]; then break; fi
  sleep 1
done

export TEST_DATABASE_URL="postgres://postgres:test@localhost:$PG_PORT/postgres"
export TEST_REDIS_URL="redis://localhost:$REDIS_PORT"

echo "[integration] running relayer suite against live backends"
npx vitest run
