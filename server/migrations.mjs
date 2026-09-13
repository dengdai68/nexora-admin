/**
 * 版本化迁移（REQ-011 / NEXORA-RBAC-011）：schema_migrations 表记录已应用版本，按升序幂等执行。
 * 新增结构变更只能追加新版本，不得回改已发布版本；每个版本在事务内执行。
 * v002 引入 RBAC 结构（users.status + roles/permissions/role_permissions/user_roles/audit_events，无 CASCADE）；
 * v003 以 PERMISSION_CATALOG 为权威种子权限目录与内置 super_admin 角色（不绑定任何用户，AC-34）。
 */
import { openDatabase } from './db.mjs';
import { PERMISSION_CATALOG, SUPER_ADMIN_ROLE_KEY } from './permissions.mjs';

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
  {
    version: 2,
    name: 'v002_rbac_schema',
    // users.status：'active' | 'disabled'，存量行由默认值回填 'active'（权限语义不变，AC-33）。
    // 全库不使用任何 ON DELETE CASCADE：删除角色前必须先解除绑定（AC-11，不静默级联）。
    sql: `
      ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

      CREATE TABLE roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE permissions (
        key TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        module_name TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        page TEXT NOT NULL DEFAULT '',
        apis TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE role_permissions (
        role_id INTEGER NOT NULL REFERENCES roles(id),
        permission_key TEXT NOT NULL REFERENCES permissions(key),
        PRIMARY KEY (role_id, permission_key)
      );

      CREATE TABLE user_roles (
        user_id INTEGER NOT NULL REFERENCES users(id),
        role_id INTEGER NOT NULL REFERENCES roles(id),
        granted_by INTEGER NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, role_id)
      );

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER NULL,
        actor_username TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL DEFAULT '',
        target_label TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL CHECK (result IN ('success','denied')),
        reason TEXT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX idx_user_roles_role_id ON user_roles(role_id);
      CREATE INDEX idx_role_permissions_key ON role_permissions(permission_key);
      CREATE INDEX idx_audit_created ON audit_events(created_at);
      CREATE INDEX idx_audit_actor ON audit_events(actor_username);
      CREATE INDEX idx_audit_action ON audit_events(action);
      CREATE INDEX idx_audit_target ON audit_events(target_type, target_id);
    `,
  },
  {
    version: 3,
    name: 'v003_seed_rbac',
    // 以目录常量为权威做首次种子（INSERT OR IGNORE 语义）；
    // 内置 super_admin 角色授予全量目录权限（D-04）；不创建任何 user_roles 绑定（AC-34）。
    apply(db) {
      const insertPermission = db.prepare(
        `INSERT OR IGNORE INTO permissions (key, module, module_name, name, description, page, apis, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of PERMISSION_CATALOG) {
        insertPermission.run(p.key, p.module, p.moduleName, p.name, p.description, p.page, JSON.stringify(p.apis), p.sortOrder);
      }
      const now = Date.now();
      db.prepare(
        `INSERT OR IGNORE INTO roles (key, name, description, status, is_builtin, created_at, updated_at)
         VALUES (?, '超级管理员', '内置超级管理员角色：拥有权限目录全部权限，受保护不可编辑/删除/禁用', 'active', 1, ?, ?)`,
      ).run(SUPER_ADMIN_ROLE_KEY, now, now);
      const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(SUPER_ADMIN_ROLE_KEY);
      const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)');
      for (const p of PERMISSION_CATALOG) {
        grant.run(Number(role.id), p.key);
      }
    },
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
      if (typeof migration.apply === 'function') {
        migration.apply(db);
      } else {
        db.exec(migration.sql);
      }
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

/** 迁移登记表（冻结；升级演练测试用 v001 DDL 构造旧库）。 */
export const MIGRATIONS_REGISTRY = Object.freeze(MIGRATIONS);
