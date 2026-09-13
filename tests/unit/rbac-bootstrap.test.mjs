/**
 * T-09 引导脚本单测（AC-35 / AD-12，临时库 + 虚构用户，不触碰真实服务数据）：
 * 四路径行为矩阵（成功/幂等/账号不存在/缺 super_admin 角色）；
 * 幂等：重复执行 user_roles 行数与审计行数不增；并发收敛（INSERT OR IGNORE 主键冲突）；
 * CLI 参数解析（--username 唯一合法形式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMigratedDatabase } from '../../server/migrations.mjs';
import { createAuditService } from '../../server/audit-service.mjs';
import { fakeClock } from '../../server/clock.mjs';
import { bootstrapAdmin, parseArgs, BOOTSTRAP_ACTOR } from '../../server/bootstrap-admin.mjs';
import { insertUser } from '../../server/db.mjs';

function withEnv(fn, { seedUser = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-bootstrap-'));
  const db = openMigratedDatabase(join(dir, 'test.db'));
  const clock = fakeClock(1_700_000_000_000);
  const audit = createAuditService({ db, clock });
  if (seedUser) insertUser(db, { username: 'admin', passwordHash: 'scrypt:stub', createdAt: 1 });
  try {
    return fn({ db, audit, clock });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const roleBindings = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM user_roles').get().n);
const auditRows = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n);

test('bootstrap: 对已存在账号授权成功并写审计（actor=system:bootstrap，granted_by=NULL）', () =>
  withEnv(({ db, audit }) => {
    const result = bootstrapAdmin(db, audit, 'admin', 1_700_000_000_000);
    assert.deepEqual(result, { status: 'granted' });
    assert.equal(roleBindings(db), 1);
    const row = db
      .prepare(
        `SELECT ur.granted_by, r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id WHERE u.username = 'admin'`,
      )
      .get();
    assert.equal(row.key, 'super_admin');
    assert.equal(row.granted_by, null, '引导授权 granted_by 为 NULL（系统）');
    const event = db.prepare('SELECT * FROM audit_events').get();
    assert.equal(event.actor_username, BOOTSTRAP_ACTOR);
    assert.equal(event.actor_user_id, null);
    assert.equal(event.action, 'admin.bootstrap');
    assert.equal(event.result, 'success');
    assert.deepEqual(JSON.parse(event.detail), { after: { role: 'super_admin' } });
  }));

test('bootstrap: 幂等——重复执行与并发收敛均不重复绑定、不重复写审计', () =>
  withEnv(({ db, audit }) => {
    assert.deepEqual(bootstrapAdmin(db, audit, 'admin', 1), { status: 'granted' });
    assert.deepEqual(bootstrapAdmin(db, audit, 'admin', 2), { status: 'already' }, '第二次幂等');
    // 模拟并发：两次调用在主键约束 + INSERT OR IGNORE 下收敛（第二次 changes=0 → already）
    assert.deepEqual(bootstrapAdmin(db, audit, 'admin', 3), { status: 'already' });
    assert.equal(roleBindings(db), 1, '绑定行数不增');
    assert.equal(auditRows(db), 1, '审计行数不增');
  }));

test('bootstrap: 账号不存在 → 明确失败，不创建账号、不写审计', () =>
  withEnv(({ db, audit }) => {
    const result = bootstrapAdmin(db, audit, 'ghost_99', 1);
    assert.deepEqual(result, { status: 'no_user' });
    const users = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
    assert.equal(users, 1, '不创建账号');
    assert.equal(roleBindings(db), 0);
    assert.equal(auditRows(db), 0, '失败路径不写审计');
  }));

test('bootstrap: super_admin 角色缺失（环境异常）→ 明确失败，不写数据', () =>
  withEnv(({ db, audit }) => {
    // 构造「已迁移但内置角色缺失」的异常状态（先清绑定再删角色，遵守无 CASCADE 约定）
    const role = db.prepare('SELECT id FROM roles WHERE key = ?').get('super_admin');
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(Number(role.id));
    db.prepare('DELETE FROM roles WHERE id = ?').run(Number(role.id));
    const result = bootstrapAdmin(db, audit, 'admin', 1);
    assert.deepEqual(result, { status: 'no_super_admin_role' });
    assert.equal(roleBindings(db), 0, '不写绑定');
    assert.equal(auditRows(db), 0, '不写审计');
  }));

test('bootstrap: CLI 参数解析——仅接受 --username <name>', () => {
  assert.deepEqual(parseArgs(['--username', 'admin']), { ok: true, username: 'admin' });
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(['--username']).ok, false);
  assert.equal(parseArgs(['--username', 'a', 'b']).ok, false);
  assert.equal(parseArgs(['--user', 'admin']).ok, false);
  assert.equal(parseArgs(['--username', '']).ok, false);
});
