/**
 * T-04 审计服务单测（AC-32）：成功/拒绝事件字段完整；筛选（操作者/对象/动作/时间/分页）正确；
 * detail 白名单断言（凭据类键拒绝写入，防御性脱敏）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMigratedDatabase } from '../../server/migrations.mjs';
import { AUDIT_ACTIONS, createAuditService } from '../../server/audit-service.mjs';
import { fakeClock } from '../../server/clock.mjs';

function withAudit(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-audit-'));
  const db = openMigratedDatabase(join(dir, 'test.db'));
  const clock = fakeClock(1_700_000_000_000);
  const audit = createAuditService({ db, clock });
  try {
    return fn({ db, clock, audit });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('audit: 成功与拒绝事件字段完整（操作者/对象/动作/差异/结果/原因/时间）', () =>
  withAudit(({ audit }) => {
    audit.record({
      actor: { id: 1, username: 'admin' },
      action: AUDIT_ACTIONS.ROLE_ASSIGN_PERMISSIONS,
      target: { type: 'role', id: '7', label: '运营专员' },
      result: 'success',
      detail: { before: { permissionKeys: ['role:read'] }, after: { permissionKeys: ['role:read', 'user:read'] } },
    });
    audit.record({
      actor: { id: 2, username: 'ops_user' },
      action: AUDIT_ACTIONS.ROLE_DELETE,
      target: { type: 'role', id: '9', label: '财务' },
      result: 'denied',
      reason: 'role_in_use',
    });
    const { items, total } = audit.query({ page: 1, pageSize: 20 });
    assert.equal(total, 2);
    const denied = items.find((i) => i.result === 'denied');
    assert.equal(denied.actorUsername, 'ops_user');
    assert.equal(denied.reason, 'role_in_use');
    assert.equal(denied.targetType, 'role');
    assert.equal(denied.targetLabel, '财务');
    const success = items.find((i) => i.result === 'success');
    assert.deepEqual(success.detail.after.permissionKeys, ['role:read', 'user:read'], 'detail 反序列化为对象');
    assert.equal(typeof success.createdAt, 'number');
    assert.ok(!JSON.stringify(success).toLowerCase().includes('password'), '审计输出不含凭据字段');
  }));

test('audit: 筛选——actor/target 子串、action 精确、时间闭区间、分页', () =>
  withAudit(({ audit, clock }) => {
    const seed = [
      { actor: 'admin', action: AUDIT_ACTIONS.ROLE_CREATE, targetId: '3', label: '运营专员' },
      { actor: 'admin', action: AUDIT_ACTIONS.USER_ASSIGN_ROLES, targetId: 'user_01', label: 'user_01' },
      { actor: 'ops_admin', action: AUDIT_ACTIONS.ROLE_DELETE, targetId: '4', label: '临时角色' },
    ];
    for (const entry of seed) {
      audit.record({
        actor: { id: 1, username: entry.actor },
        action: entry.action,
        target: { type: 'role', id: entry.targetId, label: entry.label },
        result: 'success',
      });
      clock.advance(1000);
    }
    assert.equal(audit.query({ actor: 'ops', page: 1, pageSize: 20 }).total, 1, 'actor 子串');
    assert.equal(audit.query({ target: 'user_01', page: 1, pageSize: 20 }).total, 1, 'target 子串');
    assert.equal(audit.query({ action: AUDIT_ACTIONS.ROLE_CREATE, page: 1, pageSize: 20 }).total, 1, 'action 精确');
    const t0 = 1_700_000_000_000;
    assert.equal(audit.query({ from: t0 + 1000, to: t0 + 2000, page: 1, pageSize: 20 }).total, 2, '时间闭区间');
    const page1 = audit.query({ page: 1, pageSize: 2 });
    const page2 = audit.query({ page: 2, pageSize: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page2.items.length, 1);
    assert.equal(page1.total, 3);
    assert.ok(page1.items[0].id > page1.items[1].id, '按 id 倒序（最新在前）');
  }));

test('audit: detail 白名单防御——凭据类键与非白名单键一律拒绝写入', () =>
  withAudit(({ audit }) => {
    const base = {
      actor: { id: 1, username: 'admin' },
      action: AUDIT_ACTIONS.USER_STATUS,
      target: { type: 'user', id: 'u', label: 'u' },
      result: 'success',
    };
    assert.throws(() => audit.record({ ...base, detail: { before: { password: 'x' } } }), /非白名单键/, 'password 键被拒');
    assert.throws(() => audit.record({ ...base, detail: { token: 'x' } }), /非白名单键|必须为对象/, '顶层非白名单键被拒');
    assert.throws(() => audit.record({ ...base, detail: 'raw-string' }), /必须为对象/);
    // 白名单内键正常
    const id = audit.record({ ...base, detail: { before: { status: 'active' }, after: { status: 'disabled' } } });
    assert.ok(id > 0);
  }));
