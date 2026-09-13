/**
 * e2e：用户管理 API（NEXORA-RBAC-011 / T-06；真实 HTTP 服务 + 隔离临时库 + 虚构用户）。
 * 覆盖：列表/搜索/分页/详情（AC-20）、伪造身份字段忽略（AC-25）、未知/重复/禁用角色整体 400（AC-21）、
 * 撤权下一请求 403（AC-23）、禁用后旧会话 401 且启用不复活（AC-22）、非 super_admin 分配 super_admin 403（AC-26）、
 * 越权分配 403（AC-27）、并发最后管理员保护（AC-28）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-harness.mjs';
import {
  login,
  registerAndBootstrap,
  registerAndLogin,
  registerBootstrapLogin,
  writeCall,
} from './admin-helpers.mjs';

const ADMIN = { username: 'root_admin', password: 'Admin@12345' };

test('e2e(admin-users): 列表/搜索/分页/详情展示角色与启用状态（AC-20）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  await registerAndLogin(server, 'member_01', 'Password@123');
  await registerAndLogin(server, 'member_02', 'Password@123');
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '运营专员', key: 'ops_lead', description: '' } });
  await writeCall(admin, '/api/admin/users/member_01/roles', { method: 'PUT', body: { roleIds: [created.body.role.id] } });

  const list = await admin.request('/api/admin/users');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 3);
  const member = list.body.items.find((u) => u.username === 'member_01');
  assert.equal(member.status, 'active');
  assert.deepEqual(member.roles.map((r) => r.key), ['ops_lead'], '列表含角色');

  const search = await admin.request('/api/admin/users?q=member_0');
  assert.equal(search.body.total, 2);
  const paged = await admin.request('/api/admin/users?page=2&pageSize=2');
  assert.equal(paged.body.items.length, 1, '3 用户 pageSize=2 第 2 页 1 条');

  const detail = await admin.request('/api/admin/users/member_01');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.user.roles[0].name, '运营专员');
  const missing = await admin.request('/api/admin/users/ghost_99');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});

test('e2e(admin-users): 伪造请求体身份/角色/permission 字段被忽略（AC-25）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const member = await registerAndLogin(server, 'member_01', 'Password@123');

  // 普通用户伪造 super_admin 身份字段直调管理 API → 仍按真实会话判定（无权限 403）
  const forged = await member.request('/api/admin/users', {
    method: 'GET',
    headers: { 'X-User-Role': 'super_admin' },
  });
  assert.equal(forged.status, 403, '伪造头不改变判定');
  const forgedBody = await writeCall(member, '/api/admin/users/member_01/roles', {
    method: 'PUT',
    body: { roleIds: [], actor: 'admin', isSuperAdmin: true, permissions: ['*'] },
  });
  assert.equal(forgedBody.status, 403, '伪造 body 字段被忽略，按会话权限 403');
  assert.equal(forgedBody.body.error.code, 'forbidden');

  // super_admin 正常操作带伪造字段 → 行为不受影响（忽略多余字段）
  const created = await writeCall(admin, '/api/admin/roles', {
    body: { name: '运营专员', key: 'ops_lead', description: '', actor: 'ghost', isBuiltin: 1 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role.isBuiltin, false, '伪造 isBuiltin 字段不生效');
});

test('e2e(admin-users): 未知/重复/禁用角色整体 400，无部分成功（AC-21）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  await registerAndLogin(server, 'member_01', 'Password@123');
  const roleA = await writeCall(admin, '/api/admin/roles', { body: { name: '角色甲', key: 'role_a', description: '' } });
  const roleB = await writeCall(admin, '/api/admin/roles', { body: { name: '角色乙', key: 'role_b', description: '' } });

  const unknown = await writeCall(admin, '/api/admin/users/member_01/roles', {
    method: 'PUT',
    body: { roleIds: [roleA.body.role.id, 99999] },
  });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.body.error.fields.roleIds.includes('99999'));
  const dup = await writeCall(admin, '/api/admin/users/member_01/roles', {
    method: 'PUT',
    body: { roleIds: [roleA.body.role.id, roleA.body.role.id] },
  });
  assert.equal(dup.status, 400);
  // 禁用角色不可作为新增绑定
  await writeCall(admin, `/api/admin/roles/${roleB.body.role.id}/status`, { body: { status: 'disabled' } });
  const disabledBind = await writeCall(admin, '/api/admin/users/member_01/roles', {
    method: 'PUT',
    body: { roleIds: [roleB.body.role.id] },
  });
  assert.equal(disabledBind.status, 400);
  assert.ok(disabledBind.body.error.fields.roleIds.includes('role_b'));
  // 均未产生绑定
  const detail = await admin.request('/api/admin/users/member_01');
  assert.deepEqual(detail.body.user.roles, [], '非法提交无部分成功');
});

test('e2e(admin-users): 撤权（解绑/禁用角色）后下一请求即 403（AC-23，不等会话到期）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const member = await registerAndLogin(server, 'member_01', 'Password@123');
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '只读员', key: 'viewer', description: '' } });
  const roleId = created.body.role.id;
  await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: ['user:read'] } });
  await writeCall(admin, '/api/admin/users/member_01/roles', { method: 'PUT', body: { roleIds: [roleId] } });

  assert.equal((await member.request('/api/admin/users')).status, 200, '绑定后获准');
  // 路径一：解绑 → 下一请求 403
  await writeCall(admin, '/api/admin/users/member_01/roles', { method: 'PUT', body: { roleIds: [] } });
  const afterUnbind = await member.request('/api/admin/users');
  assert.equal(afterUnbind.status, 403);
  assert.equal(afterUnbind.body.error.code, 'forbidden');
  // 路径二：重新绑定后禁用角色 → 下一请求 403
  await writeCall(admin, '/api/admin/users/member_01/roles', { method: 'PUT', body: { roleIds: [roleId] } });
  assert.equal((await member.request('/api/admin/users')).status, 200);
  await writeCall(admin, `/api/admin/roles/${roleId}/status`, { body: { status: 'disabled' } });
  assert.equal((await member.request('/api/admin/users')).status, 403, '角色禁用即时生效');
  // 路径三：取消角色权限 → 下一请求 403
  await writeCall(admin, `/api/admin/roles/${roleId}/status`, { body: { status: 'active' } });
  assert.equal((await member.request('/api/admin/users')).status, 200);
  await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: [] } });
  assert.equal((await member.request('/api/admin/users')).status, 403, '取消权限即时生效');
});

test('e2e(admin-users): 禁用用户 → 旧会话 401；重新启用旧会话仍 401，须重新登录（AC-22）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const member = await registerAndLogin(server, 'member_01', 'Password@123');
  assert.equal((await member.request('/api/me')).status, 200);

  const disabled = await writeCall(admin, '/api/admin/users/member_01/status', { body: { status: 'disabled' } });
  assert.equal(disabled.status, 200);
  const meAfter = await member.request('/api/me');
  assert.equal(meAfter.status, 401, '禁用后旧会话访问受保护接口 401');
  const loginDisabled = await member.request('/api/login', {
    method: 'POST',
    body: { username: 'member_01', password: 'Password@123' },
  });
  assert.equal(loginDisabled.status, 401, '禁用用户登录被拒');
  assert.equal(loginDisabled.body.error.code, 'invalid_credentials', '与密码错误逐字节一致（防枚举）');

  await writeCall(admin, '/api/admin/users/member_01/status', { body: { status: 'active' } });
  assert.equal((await member.request('/api/me')).status, 401, '重新启用不复活旧会话');
  const relogin = await login(member, 'member_01', 'Password@123');
  assert.equal(relogin.status, 200, '重新登录可恢复访问');
  assert.equal((await member.request('/api/me')).status, 200);
});

test('e2e(admin-users): 非 super_admin 分配/撤销 super_admin 角色 → 403 + 审计（AC-26）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  // 权限管理员：仅 user:read + user:assign_roles
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '用户管理员', key: 'user_admin', description: '' } });
  await writeCall(admin, `/api/admin/roles/${created.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['user:read', 'user:assign_roles'] },
  });
  const permAdmin = await registerAndLogin(server, 'perm_admin_1', 'Password@123');
  await writeCall(admin, '/api/admin/users/perm_admin_1/roles', { method: 'PUT', body: { roleIds: [created.body.role.id] } });
  await registerAndLogin(server, 'member_01', 'Password@123');

  const roles = await admin.request('/api/admin/roles?q=super_admin');
  const superRoleId = roles.body.items[0].id;
  const deny = await writeCall(permAdmin, '/api/admin/users/member_01/roles', {
    method: 'PUT',
    body: { roleIds: [superRoleId] },
  });
  assert.equal(deny.status, 403);
  assert.equal(deny.body.error.code, 'super_admin_required');
  // 审计留痕
  const audit = await admin.request('/api/admin/audit-events?action=user.assign_roles');
  const denied = audit.body.items.find((i) => i.result === 'denied');
  assert.equal(denied.reason, 'super_admin_required');
  assert.equal(denied.actorUsername, 'perm_admin_1');
  // super_admin 自己可以分配
  const grant = await writeCall(admin, '/api/admin/users/member_01/roles', { method: 'PUT', body: { roleIds: [superRoleId] } });
  assert.equal(grant.status, 200, 'super_admin 可分配 super_admin');
});

test('e2e(admin-users): 普通授权者分配含自身不具备权限的角色 → 403 grant_out_of_scope（AC-27）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  // 授权者：user:read + user:assign_roles
  const grantorRole = await writeCall(admin, '/api/admin/roles', { body: { name: '用户管理员', key: 'user_admin', description: '' } });
  await writeCall(admin, `/api/admin/roles/${grantorRole.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['user:read', 'user:assign_roles'] },
  });
  const grantor = await registerAndLogin(server, 'grantor_01', 'Password@123');
  await writeCall(admin, '/api/admin/users/grantor_01/roles', { method: 'PUT', body: { roleIds: [grantorRole.body.role.id] } });
  // 目标角色含 audit:read（授权者不具备）
  const richRole = await writeCall(admin, '/api/admin/roles', { body: { name: '审计专员', key: 'audit_lead', description: '' } });
  await writeCall(admin, `/api/admin/roles/${richRole.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['audit:read'] },
  });
  await registerAndLogin(server, 'member_01', 'Password@123');

  const deny = await writeCall(grantor, '/api/admin/users/member_01/roles', {
    method: 'PUT',
    body: { roleIds: [richRole.body.role.id] },
  });
  assert.equal(deny.status, 403);
  assert.equal(deny.body.error.code, 'grant_out_of_scope');
  assert.ok(deny.body.error.message.includes('audit:read'));
  // 分配空权限角色（权限并集 ⊆ 自身）→ 允许
  const emptyRole = await writeCall(admin, '/api/admin/roles', { body: { name: '空角色', key: 'empty_role', description: '' } });
  const ok = await writeCall(grantor, '/api/admin/users/member_01/roles', {
    method: 'PUT',
    body: { roleIds: [emptyRole.body.role.id] },
  });
  assert.equal(ok.status, 200);
});

test('e2e(admin-users): 最后一名启用 super_admin 保护——禁用/撤权被拒；并发双请求最多一单成功（AC-28）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);

  // 单人时：禁用与撤权均被拒
  const roles = await admin.request('/api/admin/roles?q=super_admin');
  const superRoleId = roles.body.items[0].id;
  const disableSelf = await writeCall(admin, `/api/admin/users/${ADMIN.username}/status`, { body: { status: 'disabled' } });
  assert.equal(disableSelf.status, 409);
  assert.equal(disableSelf.body.error.code, 'last_super_admin');
  const unbindSelf = await writeCall(admin, `/api/admin/users/${ADMIN.username}/roles`, { method: 'PUT', body: { roleIds: [] } });
  assert.equal(unbindSelf.status, 409);
  assert.equal(unbindSelf.body.error.code, 'last_super_admin');

  // 并发：两名 super_admin，同时互相禁用 → 最多一单成功，系统始终 ≥1 名启用 super_admin。
  // 合法交错两种：后进入守卫的请求命中事务内计数校验 → 409；或负者先被禁用（会话被撤销）→ 其请求 401。
  // 两种交错下「至多一单成功」的不变量均成立（BEGIN IMMEDIATE 串行化 + 事务内计数）。
  await registerAndBootstrap(server, 'second_admin', 'Admin@12345');
  const second = server.client();
  await login(second, 'second_admin', 'Admin@12345');
  const [r1, r2] = await Promise.all([
    writeCall(admin, '/api/admin/users/second_admin/status', { body: { status: 'disabled' } }),
    writeCall(second, `/api/admin/users/${ADMIN.username}/status`, { body: { status: 'disabled' } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.equal(statuses.filter((s) => s === 200).length, 1, '并发禁用恰好一单成功');
  assert.ok(statuses.includes(409) || statuses.includes(401), '另一单被事务守卫 409 或会话失效 401');
  // 用胜方（会话仍有效）客户端做终态断言
  const winner = r1.status === 200 ? admin : second;
  const users = await winner.request('/api/admin/users');
  const enabledSupers = users.body.items.filter(
    (u) => u.status === 'active' && u.roles.some((r) => r.key === 'super_admin'),
  );
  assert.ok(enabledSupers.length >= 1, '并发下仍至少保留一名启用 super_admin');
  // 审计含 last_super_admin 拒绝事件（若负者请求走到业务规则；401 交错下负者在守卫层被拒，无业务审计）
  const audit = await winner.request('/api/admin/audit-events?action=user.status');
  if (statuses.includes(409)) {
    assert.ok(audit.body.items.some((i) => i.result === 'denied' && i.reason === 'last_super_admin'));
  }
});

test('e2e(admin-users): 非 super_admin 操作 super_admin 成员状态 → 403 super_admin_required（P-05/AC-29）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '用户管理员', key: 'user_admin', description: '' } });
  await writeCall(admin, `/api/admin/roles/${created.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['user:read', 'user:status'] },
  });
  const permAdmin = await registerAndLogin(server, 'perm_admin_1', 'Password@123');
  await writeCall(admin, '/api/admin/users/perm_admin_1/roles', { method: 'PUT', body: { roleIds: [created.body.role.id] } });

  const deny = await writeCall(permAdmin, `/api/admin/users/${ADMIN.username}/status`, { body: { status: 'disabled' } });
  assert.equal(deny.status, 403);
  assert.equal(deny.body.error.code, 'super_admin_required');
  const audit = await admin.request('/api/admin/audit-events?action=user.status');
  assert.ok(audit.body.items.some((i) => i.result === 'denied' && i.reason === 'super_admin_required'));
});
