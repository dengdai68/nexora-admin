/**
 * T-01 RBAC 迁移单测（AC-33/AC-34）：
 * 仅含 v001 数据（旧用户 + 旧会话）的临时库升级 → 旧行完整、status 回填 'active'、迁移幂等；
 * v003 后目录 10 行、super_admin 角色存在且权限数 = 目录数、user_roles 为空（不自动提升任何账号）；
 * 外键生效：不存在 role/permission 的绑定被拒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/db.mjs';
import { MIGRATIONS_REGISTRY, runMigrations } from '../../server/migrations.mjs';
import { PERMISSION_CATALOG, SUPER_ADMIN_ROLE_KEY } from '../../server/permissions.mjs';
import { insertSession, insertUser } from '../../server/db.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-rbac-mig-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 构造仅应用 v001 的旧库（含旧用户与旧会话）。 */
function createV001Database(dbPath) {
  const db = openDatabase(dbPath);
  const v001 = MIGRATIONS_REGISTRY.find((m) => m.version === 1);
  db.exec('BEGIN');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
  db.exec(v001.sql);
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, Date.now());
  db.exec('COMMIT');
  const userId = insertUser(db, { username: 'legacy_user', passwordHash: 'scrypt:stub', createdAt: 1700000000000 });
  insertSession(db, { userId, tokenHash: 'a'.repeat(64), createdAt: 1700000000000, expiresAt: 1700086400000 });
  return db;
}

test('migrations-rbac: v001 旧库升级后旧用户/旧会话完整，status 回填 active（AC-33）', () =>
  withTempDir((dir) => {
    const dbPath = join(dir, 'legacy.db');
    const db = createV001Database(dbPath);
    const applied = runMigrations(db);
    assert.deepEqual(applied, [2, 3], '旧库只追加应用 v002/v003');
    const user = db.prepare('SELECT username, status, created_at FROM users WHERE username = ?').get('legacy_user');
    assert.equal(user.status, 'active', '存量用户 status 回填 active');
    assert.equal(Number(user.created_at), 1700000000000, '旧用户字段不变');
    const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    assert.equal(Number(sessions), 1, '旧会话保留');
    db.close();
  }));

test('migrations-rbac: 迁移幂等——重复执行无副作用（AC-33）', () =>
  withTempDir((dir) => {
    const dbPath = join(dir, 'idem.db');
    const db = createV001Database(dbPath);
    runMigrations(db);
    const snapshot = {
      roles: Number(db.prepare('SELECT COUNT(*) AS n FROM roles').get().n),
      permissions: Number(db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n),
      rolePermissions: Number(db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n),
      users: Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n),
    };
    const second = runMigrations(db);
    assert.deepEqual(second, [], '重复执行不新增版本');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM roles').get().n), snapshot.roles);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n), snapshot.permissions);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n), snapshot.rolePermissions);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n), snapshot.users);
    db.close();
  }));

test('migrations-rbac: v003 种子——目录 10 行、super_admin 全量权限、无任何用户绑定（AC-34）', () =>
  withTempDir((dir) => {
    const dbPath = join(dir, 'seed.db');
    const db = createV001Database(dbPath);
    runMigrations(db);
    const permissions = Number(db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n);
    assert.equal(permissions, PERMISSION_CATALOG.length, '目录行数与代码目录一致');
    const role = db.prepare('SELECT id, is_builtin, status FROM roles WHERE key = ?').get(SUPER_ADMIN_ROLE_KEY);
    assert.ok(role, 'super_admin 角色存在');
    assert.equal(Number(role.is_builtin), 1);
    assert.equal(role.status, 'active');
    const granted = Number(db.prepare('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = ?').get(role.id).n);
    assert.equal(granted, PERMISSION_CATALOG.length, 'super_admin 拥有目录全量权限（D-04）');
    const bindings = Number(db.prepare('SELECT COUNT(*) AS n FROM user_roles').get().n);
    assert.equal(bindings, 0, '迁移不创建任何用户绑定（AC-34 不静默提权）');
    db.close();
  }));

test('migrations-rbac: 外键生效——不存在角色/权限的绑定被拒绝', () =>
  withTempDir((dir) => {
    const db = openDatabase(join(dir, 'fk.db'));
    runMigrations(db);
    assert.throws(
      () => db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)').run(999, 'user:read'),
      /FOREIGN KEY/,
      '未知 role_id 绑定被拒',
    );
    const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(SUPER_ADMIN_ROLE_KEY);
    assert.throws(
      () => db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)').run(Number(role.id), 'ghost:hack'),
      /FOREIGN KEY/,
      '目录外 permission key 绑定被拒（R-02 数据层兜底）',
    );
    db.close();
  }));
