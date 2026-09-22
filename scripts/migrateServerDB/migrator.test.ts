import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkPgSearchSupport, migrateDatabase } from './migrator';

vi.mock('drizzle-orm/migrator', () => ({
  readMigrationFiles: vi.fn(() => [
    {
      folderMillis: 1000,
      hash: 'hash-0001',
      sql: ['CREATE TABLE test_one (id text PRIMARY KEY);'],
    },
    {
      folderMillis: 9000,
      hash: 'hash-0090',
      sql: ['CREATE EXTENSION IF NOT EXISTS pg_search;'],
    },
    {
      folderMillis: 9300,
      hash: 'hash-0093',
      sql: ['CREATE INDEX agents_bm25_idx ON agents USING bm25 (id, title);'],
    },
    {
      folderMillis: 9400,
      hash: 'hash-0094',
      sql: ['CREATE TABLE test_two (id text PRIMARY KEY);'],
    },
  ]),
}));

describe('checkPgSearchSupport', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns false when FTS_SEARCH_PROVIDER is elasticsearch and extension is not installed', async () => {
    vi.stubEnv('FTS_SEARCH_PROVIDER', 'elasticsearch');
    const mockDb = {
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await checkPgSearchSupport(mockDb);
    expect(result).toBe(false);
  });

  it('returns false when FTS_SEARCH_PROVIDER is pg_like and extension is not installed', async () => {
    vi.stubEnv('FTS_SEARCH_PROVIDER', 'pg_like');
    const mockDb = {
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await checkPgSearchSupport(mockDb);
    expect(result).toBe(false);
  });

  it('returns true when pg_search extension is already installed', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    };

    const result = await checkPgSearchSupport(mockDb);
    expect(result).toBe(true);
  });

  it('returns false when CREATE EXTENSION throws deprecated/disallowed (Neon)', async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([]) // extension not installed
        .mockRejectedValueOnce(
          new Error('extension "pg_search" is deprecated and no longer allowed'),
        ),
    };

    const result = await checkPgSearchSupport(mockDb);
    expect(result).toBe(false);
  });

  it('returns true when CREATE EXTENSION succeeds', async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([]) // extension not installed
        .mockResolvedValueOnce([]), // CREATE EXTENSION success
    };

    const result = await checkPgSearchSupport(mockDb);
    expect(result).toBe(true);
  });
});

describe('migrateDatabase', () => {
  const dialect = new PgDialect();
  const toSql = (query: any) => {
    if (typeof query === 'string') return query;
    try {
      return dialect.sqlToQuery(query).sql;
    } catch {
      return String(query);
    }
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips pg_search and bm25 migrations when pg_search is not supported', async () => {
    const executedSql: string[] = [];
    const mockDb = {
      execute: vi.fn().mockImplementation(async (query: any) => {
        const sqlStr = toSql(query);
        if (sqlStr.includes('pg_extension')) {
          return [];
        }
        if (sqlStr.includes('CREATE EXTENSION')) {
          throw new Error('extension "pg_search" is deprecated and no longer allowed');
        }
        if (sqlStr.includes('SELECT id, hash, created_at')) {
          return []; // no prior migrations
        }
        executedSql.push(sqlStr);
        return [];
      }),
    };

    const result = await migrateDatabase(mockDb, { migrationsFolder: 'mock-folder' });

    expect(result.appliedCount).toBe(2); // 0001 and 0094
    expect(result.skippedCount).toBe(2); // 0090 and 0093

    // Verify pg_search and bm25 were NOT executed
    const executedStatements = executedSql.join('\n');
    expect(executedStatements).not.toContain('CREATE EXTENSION IF NOT EXISTS pg_search');
    expect(executedStatements).not.toContain('USING bm25');

    // But verified normal tables were executed
    expect(executedStatements).toContain('CREATE TABLE test_one');
    expect(executedStatements).toContain('CREATE TABLE test_two');

    // And verify all 4 migrations were recorded in __drizzle_migrations
    const insertCount = executedSql.filter((s) => s.includes('__drizzle_migrations')).length;
    // 1 create table + 4 inserts = 5
    expect(insertCount).toBeGreaterThanOrEqual(4);
  });

  it('executes all migrations when pg_search is supported', async () => {
    const executedSql: string[] = [];
    const mockDb = {
      execute: vi.fn().mockImplementation(async (query: any) => {
        const sqlStr = toSql(query);
        if (sqlStr.includes('pg_extension')) {
          return [{ '?column?': 1 }]; // already installed
        }
        if (sqlStr.includes('SELECT id, hash, created_at')) {
          return []; // no prior migrations
        }
        executedSql.push(sqlStr);
        return [];
      }),
    };

    const result = await migrateDatabase(mockDb, { migrationsFolder: 'mock-folder' });

    expect(result.appliedCount).toBe(4);
    expect(result.skippedCount).toBe(0);

    const executedStatements = executedSql.join('\n');
    expect(executedStatements).toContain('CREATE EXTENSION IF NOT EXISTS pg_search');
    expect(executedStatements).toContain('USING bm25');
    expect(executedStatements).toContain('CREATE TABLE test_one');
    expect(executedStatements).toContain('CREATE TABLE test_two');
  });
});
