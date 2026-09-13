/**
 * 版本化迁移（REQ-011）：schema_migrations 表记录已应用版本，按升序幂等执行。
 * 新增结构变更只能追加 v002+，不得回改 v001。
 */
import { openDatabase } from './db.mjs';

const MIGRATIONS = [
  {
    version: 1,
    name: 'v001_create_users_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    `,
  },
];

/**
 * 在已打开的数据库上执行全部未应用的迁移（幂等）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number[]} 本次新应用的版本列表
 */
export function runMigrations(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);',
  );
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row.version)),
  );
  const newlyApplied = [];
  const insertVersion = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      insertVersion.run(migration.version, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

/**
 * 便捷入口：打开数据库 → 迁移 → 返回 db。
 * @param {string} dbPath
 */
export function openMigratedDatabase(dbPath) {
  const db = openDatabase(dbPath);
  runMigrations(db);
  return db;
}

/** 已登记的迁移版本列表（测试断言用）。 */
export const MIGRATION_VERSIONS = Object.freeze(MIGRATIONS.map((m) => m.version));
