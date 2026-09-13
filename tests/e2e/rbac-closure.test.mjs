/**
 * e2e：端到端授权闭环 F-01 + 注入防护（NEXORA-RBAC-011；真实 HTTP 服务 + 隔离临时库 + 虚构用户）。
 * 覆盖：多角色并集（AC-05）、新注册默认无权限（AC-07）、撤权下一请求 403（AC-23）、
 * 每步审计留痕可检索（AC-32）、XSS 载荷入库与 API 回读不转义执行体（AC-31 API 侧）、
 * SQL 注入特征搜索被参数化处理（AC-31）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-harness.mjs';
import { login, registerAndLogin, registerBootstrapLogin, writeCall } from './admin-helpers.mjs';

const ADMIN = { username: 'root_admin', password: 'Admin@12345' };

test('e2e(rbac-closure): F-01 完整闭环——建角色→授权→绑用户→用户登录验证→撤权 403→全程审计留痕', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);

  // 1. 创建两个角色并分别授权（验证多角色并集，AC-05）
  const roleA = await writeCall(admin, '/api/admin/roles', { body: { name: '用户观察员', key: 'user_viewer', description: '看用户' } });
  await writeCall(admin, `/api/admin/roles/${roleA.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['user:read'] },
  });
  const roleB = await writeCall(admin, '/api/admin/roles', { body: { name: '角色观察员', key: 'role_viewer', description: '看角色' } });
  await writeCall(admin, `/api/admin/roles/${roleB.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['role:read'] },
  });

  // 2. 给用户绑定两个角色
  const member = await registerAndLogin(server, 'member_01', 'Password@123');
  const beforePerms = await member.request('/api/me/permissions');
  assert.deepEqual(beforePerms.body.permissions, [], '新注册默认无权限（AC-07）');
  await writeCall(admin, '/api/admin/users/member_01/roles', {
    method: 'PUT',
    body: { roleIds: [roleA.body.role.id, roleB.body.role.id] },
  });

  // 3. 用户有效权限为并集：并集内 200、并集外 403
  const perms = await member.request('/api/me/permissions');
  assert.deepEqual(perms.body.permissions, ['role:read', 'user:read'], '有效权限为两角色并集');
  assert.equal((await member.request('/api/admin/users')).status, 200);
  assert.equal((await member.request('/api/admin/roles')).status, 200);
  assert.equal((await member.request('/api/admin/permissions')).status, 403, '并集外 403');
  assert.equal((await member.request('/api/admin/audit-events')).status, 403, '并集外 403');

  // 4. 撤权（解绑一个角色）→ 该角色贡献的权限下一请求 403
  await writeCall(admin, '/api/admin/users/member_01/roles', { method: 'PUT', body: { roleIds: [roleA.body.role.id] } });
  assert.equal((await member.request('/api/admin/roles')).status, 403, '撤权即时生效');
  assert.equal((await member.request('/api/admin/users')).status, 200, '保留角色权限不受影响');

  // 5. 每一步审计留痕可检索
  const audit = await admin.request('/api/admin/audit-events?pageSize=50');
  const actions = audit.body.items.map((i) => `${i.action}:${i.result}`);
  assert.ok(actions.includes('role.create:success'), '建角色留痕');
  assert.ok(actions.includes('role.assign_permissions:success'), '角色授权留痕');
  assert.ok(actions.includes('user.assign_roles:success'), '用户授权留痕');
  assert.ok(actions.includes('admin.bootstrap:success'), '引导留痕');
  const assignEvent = audit.body.items.find((i) => i.action === 'user.assign_roles');
  assert.equal(assignEvent.actorUsername, ADMIN.username, '操作者记录');
  assert.equal(assignEvent.targetId, 'member_01', '对象记录');
  assert.ok(Array.isArray(assignEvent.detail.before.roleIds), '前后差异记录');
  assert.ok(typeof assignEvent.createdAt === 'number', '时间记录');
});

test('e2e(rbac-closure): XSS 载荷角色名入库后以纯文本回读，页面渲染只走 textContent（AC-31）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const xssName = '<script>alert(1)</script>';
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: xssName, key: 'xss_role', description: '<img onerror=x>' } });
  assert.equal(created.status, 201, 'XSS 载荷作为普通字符串入库');
  assert.equal(created.body.role.name, xssName, 'API 原样回读（JSON 文本，前端 textContent 渲染即转义）');
  const detail = await admin.request(`/api/admin/roles/${created.body.role.id}`);
  assert.equal(detail.body.role.name, xssName);
  // 前端静态防线：全部 web/*.js 不含 innerHTML 拼接（另由 frontend-admin-dom 单测断言）
});

test('e2e(rbac-closure): SQL 注入特征输入被参数化处理（AC-31）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  await writeCall(admin, '/api/admin/roles', { body: { name: '运营专员', key: 'ops_lead', description: '' } });

  // 搜索注入：LIKE 通配符与引号注入均按字面匹配，无异常数据泄露
  const inject1 = await admin.request(`/api/admin/roles?q=${encodeURIComponent("' OR '1'='1")}`);
  assert.equal(inject1.status, 200);
  assert.equal(inject1.body.total, 0, '引号注入按字面匹配，不泄露全表');
  const inject2 = await admin.request('/api/admin/roles?q=%25'); // '%' 通配符
  assert.equal(inject2.body.total, 0, 'LIKE 通配符被转义');
  const injectUser = await admin.request(`/api/admin/users?q=${encodeURIComponent("admin'--")}`);
  assert.equal(injectUser.body.total, 0);
  // 目标寻址注入：路径参数不存在即 404
  const notFound = await admin.request(`/api/admin/users/${encodeURIComponent("x' OR '1'='1")}`);
  assert.equal(notFound.status, 404);
  // 审计筛选注入同样安全
  const injectAudit = await admin.request(`/api/admin/audit-events?actor=${encodeURIComponent("' OR 1=1--")}`);
  assert.equal(injectAudit.body.total, 0);
});
