import fs from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';

export interface ResilientMigrateOptions {
  migrationsFolder: string;
}

interface JournalEntry {
  breakpoints: boolean;
  idx: number;
  tag: string;
  version: string;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

/**
 * Checks if the target PostgreSQL database supports and allows the `pg_search` extension.
 * Neon deprecates and disallows `pg_search` (throwing error 42501 via CheckAllowedExtension).
 * Standard PostgreSQL without ParadeDB does not have the extension available.
 */
export const checkPgSearchSupport = async (db: any): Promise<boolean> => {
  // 1. If explicitly configured for elasticsearch or pg_like and no pg_search is desired:
  const provider = process.env.FTS_SEARCH_PROVIDER;
  if (provider === 'elasticsearch' || provider === 'pg_like') {
    // Check if extension is already installed on the DB
    try {
      const res = await db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_search'`);
      const rows = Array.isArray(res) ? res : (res.rows ?? []);
      if (rows.length > 0) return true;
    } catch {
      // Ignore
    }
    return false;
  }

  try {
    // 2. Check if pg_search is already active
    const res = await db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_search'`);
    const rows = Array.isArray(res) ? res : (res.rows ?? []);
    if (rows.length > 0) return true;

    // 3. Probe whether CREATE EXTENSION pg_search is permitted
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_search`);
    return true;
  } catch (err: any) {
    const message = err?.message || '';
    console.info(
      `ℹ️ [Database] pg_search extension is unavailable or deprecated on this database (${message.trim()}).`,
    );
    return false;
  }
};

/**
 * Runs Drizzle migrations with safety guards for pg_search and BM25 indexes.
 * When running against Neon or standard Postgres, pg_search / BM25 statements are safely
 * skipped while recording the migration in `__drizzle_migrations`, allowing deployment to succeed.
 */
export const migrateDatabase = async (
  db: any,
  { migrationsFolder }: ResilientMigrateOptions,
): Promise<{ appliedCount: number; skippedCount: number }> => {
  const migrations = readMigrationFiles({ migrationsFolder });

  // Read journal for meaningful tag names in logs
  const journalPath = path.join(migrationsFolder, 'meta/_journal.json');
  const journalMap = new Map<number, string>();
  if (fs.existsSync(journalPath)) {
    try {
      const journal: Journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      for (const entry of journal.entries) {
        journalMap.set(entry.when, entry.tag);
      }
    } catch {
      // Ignore journal parse failure
    }
  }

  // 1. Ensure drizzle schema and __drizzle_migrations table exist
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  // 2. Fetch the latest applied migration
  const lastMigrationResult = await db.execute(sql`
    SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1
  `);
  const lastRows = Array.isArray(lastMigrationResult)
    ? lastMigrationResult
    : (lastMigrationResult.rows ?? []);
  const lastDbMigration = lastRows[0];

  // 3. Check pg_search capability
  const hasPgSearch = await checkPgSearchSupport(db);
  if (!hasPgSearch) {
    console.info(
      'ℹ️ [Database] Running in pg_search-free mode: BM25/pg_search migrations will be safely skipped.',
    );
  }

  let appliedCount = 0;
  let skippedCount = 0;

  // 4. Iterate and apply pending migrations
  for (const migration of migrations) {
    if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
      const tag = journalMap.get(migration.folderMillis) || `migration_${migration.folderMillis}`;
      const isPgSearchMigration = migration.sql.some(
        (stmt: string) =>
          stmt.toLowerCase().includes('pg_search') || stmt.toLowerCase().includes('bm25'),
      );

      if (isPgSearchMigration && !hasPgSearch) {
        console.info(
          `⏩ [Database] Skipping ${tag} (pg_search / BM25 not available on this database)`,
        );
        skippedCount++;
      } else {
        // Execute migration statements
        for (const stmt of migration.sql) {
          const trimmed = stmt.trim();
          if (!trimmed) continue;
          await db.execute(sql.raw(trimmed));
        }
        appliedCount++;
      }

      // Record migration as applied
      await db.execute(sql`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES (${migration.hash}, ${migration.folderMillis})
      `);
    }
  }

  return { appliedCount, skippedCount };
};
