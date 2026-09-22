const path = require('node:path');
const { Pool } = require('pg');
const { readMigrationFiles } = require('drizzle-orm/migrator');
const { PGVECTOR_HINT } = require('./errorHint');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set, please set it in your environment variables.');
}

const client = new Pool({ connectionString: process.env.DATABASE_URL });

const checkPgSearchSupport = async (pgClient) => {
  const provider = process.env.FTS_SEARCH_PROVIDER;
  if (provider === 'elasticsearch' || provider === 'pg_like') {
    try {
      const res = await pgClient.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_search'");
      if (res.rows.length > 0) return true;
    } catch {
      // Ignore
    }
    return false;
  }

  try {
    const res = await pgClient.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_search'");
    if (res.rows.length > 0) return true;
    await pgClient.query('CREATE EXTENSION IF NOT EXISTS pg_search');
    return true;
  } catch (err) {
    console.info(
      `ℹ️ [Database] pg_search extension is unavailable on this database (${err.message.trim()}).`,
    );
    return false;
  }
};

const runMigrations = async () => {
  console.log('[Database] Start to migration...');
  const migrationsFolder = path.join(__dirname, './migrations');
  const migrations = readMigrationFiles({ migrationsFolder });

  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const lastRes = await client.query(
    'SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  );
  const lastDbMigration = lastRes.rows[0];

  const hasPgSearch = await checkPgSearchSupport(client);

  for (const migration of migrations) {
    if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
      const isPgSearchMigration = migration.sql.some(
        (stmt) => stmt.toLowerCase().includes('pg_search') || stmt.toLowerCase().includes('bm25'),
      );

      if (isPgSearchMigration && !hasPgSearch) {
        console.info(
          `⏩ [Database] Skipping pg_search / BM25 migration: ${migration.folderMillis}`,
        );
      } else {
        for (const stmt of migration.sql) {
          const trimmed = stmt.trim();
          if (!trimmed) continue;
          await client.query(trimmed);
        }
      }

      await client.query(
        'INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)',
        [migration.hash, migration.folderMillis],
      );
    }
  }

  console.log('✅ database migration pass.');
  console.log('-------------------------------------');
  process.exit(0);
};

runMigrations().catch((err) => {
  console.error(
    '❌ Database migrate failed. Please check your database is valid and DATABASE_URL is set correctly. The error detail is below:',
  );
  console.error(err);

  if (err.message.includes('extension "vector" is not available')) {
    console.info(PGVECTOR_HINT);
  }

  process.exit(1);
});
