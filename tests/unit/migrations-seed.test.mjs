import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/db.mjs';
import { MIGRATION_VERSIONS, runMigrations } from '../../server/migrations.mjs';
import { seedDatabase, SEED_USERNAME } from '../../server/seed.mjs';

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-test-'));
  const dbPath = join(dir, 'test.db');
  try {
    return fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('migrations: 全新库执行 v001 后表结构正确', () =>
  withTempDb((dbPath) => {
    const db = openDatabase(dbPath);
    const applied = runMigrations(db);
    assert.deepEqual(applied, [1]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const name of ['users', 'sessions', 'schema_migrations']) {
      assert.ok(tables.includes(name), `缺少表 ${name}`);
    }
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(indexes.includes('idx_sessions_token_hash'));
    assert.ok(indexes.includes('idx_sessions_expires_at'));
    db.close();
  }));

test('migrations: 重复执行幂等（不报错、不重建、版本不重复记录）', () =>
  withTempDb((dbPath) => {
    const db = openDatabase(dbPath);
    runMigrations(db);
    const second = runMigrations(db);
    assert.deepEqual(second, []);
    const count = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    assert.equal(Number(count), MIGRATION_VERSIONS.length);
    db.close();
  }));

test('seed: 创建 seed_user 且密码列为 scrypt 参数化格式、非明文', () =>
  withTempDb((dbPath) => {
    const first = seedDatabase(dbPath);
    assert.equal(first.created, true);
    const db = openDatabase(dbPath);
    const row = db.prepare('SELECT username, password_hash FROM users WHERE username = ?').get(SEED_USERNAME);
    assert.match(row.password_hash, /^scrypt:16384:8:1:/);
    assert.ok(!row.password_hash.includes('Seed@12345'));
    db.close();
    // 幂等：再次执行跳过
    const second = seedDatabase(dbPath);
    assert.equal(second.created, false);
  }));
