/**
 * e2e：升级演练（NEXORA-RBAC-011 / AC-33/AC-34/AC-37）：
 * 在仅含 v001 数据（旧用户真实 scrypt 哈希 + 未过期旧会话）的库上启动新版本 →
 * 自动应用 v002/v003；旧用户可登录、旧会话照常有效（行为不变）；迁移幂等；
 * 无任何账号被自动提升（user_roles 为空）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/db.mjs';
import { MIGRATIONS_REGISTRY, runMigrations } from '../../server/migrations.mjs';
import { hashPassword } from '../../server/passwords.mjs';
import { hashToken } from '../../server/tokens.mjs';
import { createApp, startApp } from '../../server/index.mjs';
import { systemClock } from '../../server/clock.mjs';

const LEGACY_USER = { username: 'legacy_user', password: 'Legacy@12345' };
const LEGACY_TOKEN = 'legacy-session-token-for-upgrade-drill';

/** 构造 v001 旧库（真实哈希 + 有效旧会话），返回 dbPath。 */
function createLegacyDb(dir) {
  const dbPath = join(dir, 'legacy.db');
  const db = openDatabase(dbPath);
  const v001 = MIGRATIONS_REGISTRY.find((m) => m.version === 1);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
  db.exec('BEGIN');
  db.exec(v001.sql);
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, Date.now());
  db.exec('COMMIT');
  const now = Date.now();
  const userId = Number(
    db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(LEGACY_USER.username, hashPassword(LEGACY_USER.password), now).lastInsertRowid,
  );
  db.prepare('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    userId,
    hashToken(LEGACY_TOKEN),
    now,
    now + 86_400_000, // 未过期
  );
  db.close();
  return dbPath;
}

test('e2e(rbac-upgrade): v001 旧库升级——旧用户可登录、旧会话有效、无自动提权、迁移幂等（AC-33/34/37）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = createLegacyDb(dir);

  const logLines = [];
  const logger = {
    request: (m, p, s, c) => logLines.push(`request ${m} ${p} ${s} ${c}`),
    info: (m) => logLines.push(`info ${m}`),
    error: (m, s) => logLines.push(`error ${m} ${s ?? ''}`),
  };
  const app = createApp({
    config: { host: '127.0.0.1', port: 0, dbPath, sessionTtlMs: 86_400_000, commitSha: 'upgrade-test' },
    clock: systemClock(),
    logger,
  });
  const handle = await startApp(app);
  t.after(() => handle.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  // 迁移已应用 v002/v003
  const versions = app.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version));
  assert.deepEqual(versions, [1, 2, 3], '升级自动应用 v002/v003');

  // 旧会话照常有效（AC-37 会话口径不变；status 回填 active 通过请求级检查）
  const me = await fetch(`${base}/api/me`, { headers: { Cookie: `nexora_session=${LEGACY_TOKEN}` } });
  assert.equal(me.status, 200, '旧会话升级后仍有效');
  const meBody = await me.json();
  assert.equal(meBody.user.username, LEGACY_USER.username);

  // 旧用户可登录
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LEGACY_USER),
  });
  assert.equal(login.status, 200, '旧用户升级后可正常登录');

  // 升级不自动提升任何账号（AC-34）
  const bindings = Number(app.db.prepare('SELECT COUNT(*) AS n FROM user_roles').get().n);
  assert.equal(bindings, 0, '迁移后无任何账号获得角色');
  const perms = await fetch(`${base}/api/me/permissions`, { headers: { Cookie: `nexora_session=${LEGACY_TOKEN}` } });
  const permsBody = await perms.json();
  assert.deepEqual(permsBody.permissions, [], '旧用户默认无管理权限');

  // 幂等：再次执行迁移无副作用
  const again = runMigrations(app.db);
  assert.deepEqual(again, [], '重复迁移幂等');
  const roleCount = Number(app.db.prepare('SELECT COUNT(*) AS n FROM roles').get().n);
  assert.equal(roleCount, 1, 'super_admin 种子不重复');
});
