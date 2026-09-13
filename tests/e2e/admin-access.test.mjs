/**
 * e2e：统一鉴权层与只读管理 API（NEXORA-RBAC-011 / T-08；真实 HTTP 服务）。
 * 覆盖：未登录 401 / 已登录无权限 403 语义不混用（AC-24）、/api/me 契约冻结（AC-37）、
 * /api/me/permissions（AD-09）、权限目录结构与守卫（AC-13/14）、审计筛选分页与守卫（AC-32）、
 * 405/404 语义保持（AD-04 回归保护）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-harness.mjs';
import { login, registerAndLogin, registerBootstrapLogin, writeCall } from './admin-helpers.mjs';

const ADMIN = { username: 'root_admin', password: 'Admin@12345' };

test('e2e(admin-access): 未登录调任一管理 API → 401；已登录无权限 → 403（AC-24 语义不混用）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const anon = server.client();
  const member = await registerAndLogin(server, 'member_01', 'Password@123');

  const endpoints = [
    { method: 'GET', path: '/api/admin/users' },
    { method: 'GET', path: '/api/admin/users/member_01' },
    { method: 'POST', path: '/api/admin/users/member_01/status', body: { status: 'disabled' } },
    { method: 'PUT', path: '/api/admin/users/member_01/roles', body: { roleIds: [] } },
    { method: 'GET', path: '/api/admin/roles' },
    { method: 'GET', path: '/api/admin/roles/enabled' },
    { method: 'GET', path: '/api/admin/roles/1' },
    { method: 'POST', path: '/api/admin/roles', body: { name: 'x', key: 'xx', description: '' } },
    { method: 'PUT', path: '/api/admin/roles/1', body: { name: 'x', key: 'xx', description: '' } },
    { method: 'POST', path: '/api/admin/roles/1/status', body: { status: 'disabled' } },
    { method: 'DELETE', path: '/api/admin/roles/1' },
    { method: 'PUT', path: '/api/admin/roles/1/permissions', body: { permissionKeys: [] } },
    { method: 'GET', path: '/api/admin/permissions' },
    { method: 'GET', path: '/api/admin/audit-events' },
  ];
  for (const ep of endpoints) {
    const unauth = await anon.request(ep.path, { method: ep.method, body: ep.body });
    assert.equal(unauth.status, 401, `未登录 ${ep.method} ${ep.path} 应 401`);
    assert.equal(unauth.body.error.code, 'unauthorized');
    const noPerm = await member.request(ep.path, {
      method: ep.method,
      body: ep.body,
      headers: { 'X-Nexora-CSRF': '1' },
    });
    assert.equal(noPerm.status, 403, `已登录无权限 ${ep.method} ${ep.path} 应 403`);
    assert.equal(noPerm.body.error.code, 'forbidden');
  }
  // 只读接口的 403 不进审计表（AD-11 口径）
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const before = (await admin.request('/api/admin/audit-events?pageSize=50')).body.total;
  await member.request('/api/admin/users');
  await member.request('/api/admin/roles');
  const after = (await admin.request('/api/admin/audit-events?pageSize=50')).body.total;
  assert.equal(after, before, '只读 403 不刷审计表');
});

test('e2e(admin-access): /api/me 响应体逐字节冻结（AC-37），/api/me/permissions 三类角色正确（AD-09）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const anon = await server.client().request('/api/me/permissions');
  assert.equal(anon.status, 401);

  const member = await registerAndLogin(server, 'member_01', 'Password@123');
  const me = await member.request('/api/me');
  assert.deepEqual(Object.keys(me.body).sort(), ['session', 'user'], '/api/me 顶层字段不变');
  assert.deepEqual(Object.keys(me.body.user), ['username'], '/api/me user 字段不变（无角色/权限字段）');
  const memberPerms = await member.request('/api/me/permissions');
  assert.deepEqual(memberPerms.body, { permissions: [] }, '普通用户有效权限为空数组（R-03）');

  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const adminPerms = await admin.request('/api/me/permissions');
  assert.equal(adminPerms.status, 200);
  assert.equal(adminPerms.body.permissions.length, 10, 'super_admin 全量权限');
  assert.deepEqual(adminPerms.body.permissions, [...adminPerms.body.permissions].sort(), '排序去重');
});

test('e2e(admin-access): 权限目录结构与守卫（AC-13/14）——分组/字段/只读，无 permission:read → 403', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const member = await registerAndLogin(server, 'member_01', 'Password@123');
  assert.equal((await member.request('/api/admin/permissions')).status, 403);

  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const catalog = await admin.request('/api/admin/permissions');
  assert.equal(catalog.status, 200);
  const groups = catalog.body.groups;
  assert.deepEqual(groups.map((g) => g.module), ['user', 'role', 'permission', 'audit'], '按模块分组且 sort_order 有序');
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, 10, '目录 10 项权限');
  for (const group of groups) {
    for (const item of group.items) {
      assert.ok(item.key.includes(':'), '稳定 key');
      assert.ok(item.name && item.description, '名称与说明');
      assert.ok(item.page, '关联页面');
      assert.ok(Array.isArray(item.apis) && item.apis.length > 0, '关联 API');
    }
  }
});

test('e2e(admin-access): 审计筛选组合与分页（AC-32）；无 audit:read → 403；响应无凭据字段', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const member = await registerAndLogin(server, 'member_01', 'Password@123');
  assert.equal((await member.request('/api/admin/audit-events')).status, 403);

  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '运营专员', key: 'ops_lead', description: '' } });
  await writeCall(admin, `/api/admin/roles/${created.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['user:read'] },
  });

  const byActor = await admin.request('/api/admin/audit-events?actor=root_adm');
  assert.ok(byActor.body.total >= 2, 'actor 子串筛选');
  assert.ok(byActor.body.items.every((i) => i.actorUsername.includes('root_adm')));
  const byAction = await admin.request('/api/admin/audit-events?action=role.create');
  assert.equal(byAction.body.total, 1, 'action 精确筛选');
  assert.equal(byAction.body.items[0].action, 'role.create');
  const byTarget = await admin.request('/api/admin/audit-events?target=ops_lead');
  assert.ok(byTarget.body.items.every((i) => i.targetId.includes('ops_lead') || i.targetLabel.includes('ops_lead')));
  const now = Date.now();
  const byTime = await admin.request(`/api/admin/audit-events?from=${now - 60_000}&to=${now + 60_000}`);
  assert.ok(byTime.body.total >= 1, '时间闭区间筛选');
  const noResult = await admin.request(`/api/admin/audit-events?from=${now + 120_000}`);
  assert.equal(noResult.body.total, 0);
  const badAction = await admin.request('/api/admin/audit-events?action=no.such');
  assert.equal(badAction.status, 400, '未知动作码 400');

  // 分页
  const paged = await admin.request('/api/admin/audit-events?page=1&pageSize=1');
  assert.equal(paged.body.items.length, 1);
  assert.ok(paged.body.total >= 2);
  // 不输出凭据（AC-32）
  const raw = JSON.stringify(paged.body);
  for (const forbidden of ['password', 'token_hash', 'nexora_session', 'scrypt:']) {
    assert.ok(!raw.includes(forbidden), `审计响应不得含 ${forbidden}`);
  }
});

test('e2e(admin-access): 405/404 语义保持（AD-04 回归）——同路径异方法带 Allow，未知路径 404', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const wrongMethod = await admin.request('/api/admin/users', { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  assert.ok((wrongMethod.headers.get('allow') ?? '').includes('GET'), 'Allow 含既有方法');
  const wrongMethodPattern = await admin.request('/api/admin/users/some_user/roles', { method: 'POST', body: {} });
  assert.equal(wrongMethodPattern.status, 405);
  assert.ok((wrongMethodPattern.headers.get('allow') ?? '').includes('PUT'));
  const unknown = await admin.request('/api/admin/nope');
  assert.equal(unknown.status, 404);
  // 模式不多匹配尾部斜杠
  const trailing = await admin.request('/api/admin/users/');
  assert.equal(trailing.status, 404, '尾部斜杠不多匹配');
  // 既有端点回归：POST /api/me 仍 405
  const legacy = await admin.request('/api/me', { method: 'POST', body: {} });
  assert.equal(legacy.status, 405);
});
