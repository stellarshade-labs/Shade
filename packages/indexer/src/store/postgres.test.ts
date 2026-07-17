import { describe } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { describeAnnouncementStoreSpec } from './announcements.spec-shared.js';
import { PostgresAnnouncementStore } from './postgres.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Build a `pg` Pool whose every connection is pinned to `schema` via
 * `search_path`, so all tables the store creates and reads live in that
 * per-test schema. Isolating each test in its own schema keeps the parallel
 * cases from colliding on the shared database.
 */
function makeSchemaPool(schema: string): Pool {
  return new Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 5,
  });
}

/** A fresh, collision-free schema identifier for one test. */
function freshSchema(): string {
  return `shade_test_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Harness factory for the shared {@link describeAnnouncementStoreSpec}. Each
 * call creates a brand-new schema (via a bootstrap connection), then a
 * schema-pinned pool + an initialised {@link PostgresAnnouncementStore};
 * `cleanup` drops the schema and closes the pool.
 */
async function makePostgresHarness() {
  const schema = freshSchema();

  const bootstrap = new Pool({ connectionString: DATABASE_URL, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await bootstrap.end();

  const pool = makeSchemaPool(schema);
  const store = new PostgresAnnouncementStore(pool);
  await store.init();

  return {
    store,
    cleanup: async () => {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

// Backend-agnostic AnnouncementStore contract against Postgres — the identical
// spec the memory backend runs. Skipped unless a real database is provided.
describe.skipIf(!DATABASE_URL)('postgres backend', () => {
  describeAnnouncementStoreSpec('AnnouncementStore (Postgres)', makePostgresHarness);
});
