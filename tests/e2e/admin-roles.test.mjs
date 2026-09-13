/**
 * e2e：角色管理 API（NEXORA-RBAC-011 / T-07；真实 HTTP 服务 + 隔离临时库 + 虚构用户）。
 * 覆盖：CRUD/搜索/分页/冲突（AC-09/10/11）、super_admin 全保护矩阵（AC-12/29）、
 * 授权原子替换精确等于提交集、未知/重复 key 无部分成功（AC-19）、CSRF（AC-30）、越权授予（AC-27）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-harness.mjs';
import { registerBootstrapLogin, registerAndLogin, writeCall, login } from './admin-helpers.mjs';

const ADMIN = { username: 'root_admin', password: 'Admin@12345' };

test('e2e(admin-roles): 新建/详情/编辑/搜索/分页全流程并持久化（AC-09）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);

  const created = await writeCall(admin, '/api/admin/roles', {
    body: { name: '运营专员', key: 'ops_lead', description: '负责运营' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role.key, 'ops_lead');
  assert.deepEqual(created.body.role.permissionKeys, [], '新角色权限集为空');
  const roleId = created.body.role.id;

  const detail = await admin.request(`/api/admin/roles/${roleId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.role.name, '运营专员');
  assert.equal(detail.body.role.boundUsers, 0);

  const updated = await writeCall(admin, `/api/admin/roles/${roleId}`, {
    method: 'PUT',
    body: { name: '运营主管', key: 'ops_lead', description: '负责运营与审核' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.role.name, '运营主管');

  // 搜索（key/name 大小写不敏感子串）
  const byKey = await admin.request('/api/admin/roles?q=OPS_LEAD');
  assert.equal(byKey.body.total, 1);
  const byName = await admin.request(`/api/admin/roles?q=${encodeURIComponent('主管')}`);
  assert.equal(byName.body.total, 1);
  const none = await admin.request('/api/admin/roles?q=nothing_matches');
  assert.deepEqual(none.body.items, [], '越界/无匹配返回空 items');

  // 分页：再建 2 个角色，pageSize=2 翻页
  await writeCall(admin, '/api/admin/roles', { body: { name: '财务专员', key: 'finance', description: '' } });
  await writeCall(admin, '/api/admin/roles', { body: { name: '审计员', key: 'auditor', description: '' } });
  const page1 = await admin.request('/api/admin/roles?page=1&pageSize=2');
  const page2 = await admin.request('/api/admin/roles?page=2&pageSize=2');
  assert.equal(page1.body.total, 4); // 含内置 super_admin
  assert.equal(page1.body.items.length, 2);
  assert.equal(page2.body.items.length, 2);
  assert.notEqual(page1.body.items[0].id, page2.body.items[0].id);
  const outOfRange = await admin.request('/api/admin/roles?page=99&pageSize=2');
  assert.deepEqual(outOfRange.body.items, [], '越界页返回空（不报错）');
});

test('e2e(admin-roles): 唯一标识重复 → 409 role_key_taken 不写入（AC-10）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  await writeCall(admin, '/api/admin/roles', { body: { name: '运营专员', key: 'ops_lead', description: '' } });
  const dup = await writeCall(admin, '/api/admin/roles', { body: { name: '另一个', key: 'ops_lead', description: '' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'role_key_taken');
  const list = await admin.request('/api/admin/roles?q=ops_lead');
  assert.equal(list.body.total, 1, '冲突未写入');
  // 保留字 super_admin 不可用作自定义标识
  const reserved = await writeCall(admin, '/api/admin/roles', { body: { name: '假冒超管', key: 'super_admin', description: '' } });
  assert.equal(reserved.status, 400);
  assert.ok(reserved.body.error.fields.key);
});

test('e2e(admin-roles): super_admin 全保护矩阵——编辑/启停/删除/改权限一律 403 role_protected + 审计（AC-12）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const roles = await admin.request('/api/admin/roles?q=super_admin');
  const superRole = roles.body.items[0];
  assert.equal(superRole.isBuiltin, true);
  assert.equal(superRole.permissionCount, 10, 'super_admin 持有目录全量权限');

  const edit = await writeCall(admin, `/api/admin/roles/${superRole.id}`, {
    method: 'PUT',
    body: { name: '改名', key: 'renamed', description: '' },
  });
  assert.equal(edit.status, 403);
  assert.equal(edit.body.error.code, 'role_protected');
  const statusChange = await writeCall(admin, `/api/admin/roles/${superRole.id}/status`, {
    body: { status: 'disabled' },
  });
  assert.equal(statusChange.status, 403);
  assert.equal(statusChange.body.error.code, 'role_protected');
  const remove = await writeCall(admin, `/api/admin/roles/${superRole.id}`, { method: 'DELETE' });
  assert.equal(remove.status, 403);
  const assign = await writeCall(admin, `/api/admin/roles/${superRole.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: [] },
  });
  assert.equal(assign.status, 403);

  // 审计留痕：4 条 role_protected 拒绝事件
  const audit = await admin.request('/api/admin/audit-events?action=role.update');
  assert.equal(audit.body.total, 1);
  assert.equal(audit.body.items[0].result, 'denied');
  assert.equal(audit.body.items[0].reason, 'role_protected');
  const all = await admin.request('/api/admin/audit-events?pageSize=50');
  const denied = all.body.items.filter((i) => i.result === 'denied' && i.reason === 'role_protected');
  assert.equal(denied.length, 4, '编辑/启停/删除/改权限四条拒绝全部留痕');
});

test('e2e(admin-roles): 授权原子替换——保存后权限集精确等于提交集，回显一致（AC-18/19）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '运营专员', key: 'ops_lead', description: '' } });
  const roleId = created.body.role.id;

  const assign = await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['role:read', 'user:read', 'user:status'] },
  });
  assert.equal(assign.status, 200);
  assert.deepEqual(assign.body.role.permissionKeys, ['role:read', 'user:read', 'user:status'], '响应为排序后提交集');
  // 重新打开详情回显与数据库一致
  const detail = await admin.request(`/api/admin/roles/${roleId}`);
  assert.deepEqual(detail.body.role.permissionKeys, ['role:read', 'user:read', 'user:status']);
  // 原子替换（缩减集合）
  await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['user:read'] },
  });
  const after = await admin.request(`/api/admin/roles/${roleId}`);
  assert.deepEqual(after.body.role.permissionKeys, ['user:read'], '替换后精确等于新提交集');
});

test('e2e(admin-roles): 未知/重复/非法结构 key 整体 400，无部分成功（AC-19）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '运营专员', key: 'ops_lead', description: '' } });
  const roleId = created.body.role.id;
  await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: ['user:read'] } });

  const unknown = await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['user:read', 'ghost:hack'] },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'invalid_params');
  assert.ok(unknown.body.error.fields.permissionKeys.includes('ghost:hack'), '未知 key 列入 fields');
  const dup = await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['user:read', 'user:read'] },
  });
  assert.equal(dup.status, 400);
  const badType = await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: 'user:read' },
  });
  assert.equal(badType.status, 400);
  const detail = await admin.request(`/api/admin/roles/${roleId}`);
  assert.deepEqual(detail.body.role.permissionKeys, ['user:read'], '任何非法提交均未产生部分写入');
});

test('e2e(admin-roles): 删除绑定中角色 → 409 role_in_use 含数量与示例；解绑后可删除（AC-11）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  await registerAndLogin(server, 'member_01', 'Password@123');
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '运营专员', key: 'ops_lead', description: '' } });
  const roleId = created.body.role.id;
  await writeCall(admin, '/api/admin/users/member_01/roles', { method: 'PUT', body: { roleIds: [roleId] } });

  const conflict = await writeCall(admin, `/api/admin/roles/${roleId}`, { method: 'DELETE' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'role_in_use');
  assert.ok(conflict.body.error.message.includes('1'), '提示含绑定数量');
  assert.ok(conflict.body.error.message.includes('member_01'), '提示含示例用户名');
  const stillThere = await admin.request(`/api/admin/roles/${roleId}`);
  assert.equal(stillThere.status, 200, '冲突时角色未被删除（无静默级联）');

  await writeCall(admin, '/api/admin/users/member_01/roles', { method: 'PUT', body: { roleIds: [] } });
  const removed = await writeCall(admin, `/api/admin/roles/${roleId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const gone = await admin.request(`/api/admin/roles/${roleId}`);
  assert.equal(gone.status, 404);
});

test('e2e(admin-roles): 普通授权者越权勾选权限 → 403 grant_out_of_scope + 审计（AC-27）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  // 构造「权限管理员」：角色只有 role:read + role:assign_permissions
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '权限管理员', key: 'perm_admin', description: '' } });
  const roleId = created.body.role.id;
  await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['role:read', 'role:assign_permissions'] },
  });
  await registerAndLogin(server, 'perm_admin_1', 'Password@123');
  await writeCall(admin, '/api/admin/users/perm_admin_1/roles', { method: 'PUT', body: { roleIds: [roleId] } });
  const permAdmin = server.client();
  await login(permAdmin, 'perm_admin_1', 'Password@123');

  // 给自己角色的另一角色勾选 user:status（自身不具备）→ 403
  const created2 = await writeCall(admin, '/api/admin/roles', { body: { name: '临时角色', key: 'tmp_role', description: '' } });
  const deny = await writeCall(permAdmin, `/api/admin/roles/${created2.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['role:read', 'user:status'] },
  });
  assert.equal(deny.status, 403);
  assert.equal(deny.body.error.code, 'grant_out_of_scope');
  assert.ok(deny.body.error.message.includes('user:status'));
  // 自身权限内的子集允许
  const okAssign = await writeCall(permAdmin, `/api/admin/roles/${created2.body.role.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['role:read'] },
  });
  assert.equal(okAssign.status, 200);
  // 审计含 grant_out_of_scope 拒绝事件
  const audit = await admin.request('/api/admin/audit-events?action=role.assign_permissions');
  const denied = audit.body.items.find((i) => i.result === 'denied');
  assert.equal(denied.reason, 'grant_out_of_scope');
  assert.deepEqual(denied.detail.after.attemptedAddedKeys, ['user:status'], '审计记录企图新增的越权 key');
});

test('e2e(admin-roles): 管理写操作缺 CSRF 头 → 403 csrf_protection（AC-30）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '运营专员', key: 'ops_lead', description: '' } });
  const roleId = created.body.role.id;
  // 全部写端点逐一验证（不带 X-Nexora-CSRF）
  const noHeader = [
    await admin.request('/api/admin/roles', { method: 'POST', body: { name: 'x', key: 'xx', description: '' } }),
    await admin.request(`/api/admin/roles/${roleId}`, { method: 'PUT', body: { name: 'x', key: 'xx', description: '' } }),
    await admin.request(`/api/admin/roles/${roleId}/status`, { method: 'POST', body: { status: 'disabled' } }),
    await admin.request(`/api/admin/roles/${roleId}`, { method: 'DELETE' }),
    await admin.request(`/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: [] } }),
    await admin.request('/api/admin/users/root_admin/status', { method: 'POST', body: { status: 'disabled' } }),
    await admin.request('/api/admin/users/root_admin/roles', { method: 'PUT', body: { roleIds: [] } }),
  ];
  for (const res of noHeader) {
    assert.equal(res.status, 403, '缺 CSRF 头的写操作一律 403');
    assert.equal(res.body.error.code, 'csrf_protection');
  }
  // 错误值同样拒绝
  const wrong = await admin.request('/api/admin/roles', {
    method: 'POST',
    body: { name: 'x', key: 'xx', description: '' },
    headers: { 'X-Nexora-CSRF': 'yes' },
  });
  assert.equal(wrong.status, 403);
  // 读操作不需要该头
  const read = await admin.request('/api/admin/roles');
  assert.equal(read.status, 200);
});

test('e2e(admin-roles): DEF-01 回归——super_admin 保护判定先于载荷校验，任何载荷均 403 role_protected + 审计', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const admin = await registerBootstrapLogin(server, ADMIN.username, ADMIN.password);
  const roles = await admin.request('/api/admin/roles?q=super_admin');
  const superRole = roles.body.items[0];

  // ① 保留 key 仅改名（DEF-01 原始复现路径）→ 403 role_protected（修复前为 400 invalid_params）
  const renameOnly = await writeCall(admin, `/api/admin/roles/${superRole.id}`, {
    method: 'PUT',
    body: { name: '改名尝试', key: 'super_admin', description: '' },
  });
  assert.equal(renameOnly.status, 403, '保留 key 改名应 403 role_protected');
  assert.equal(renameOnly.body.error.code, 'role_protected');

  // ② 非法载荷也先命中保护（而非 400）：非法 key 格式 / 非法 status / 未知 permissionKeys
  const badKey = await writeCall(admin, `/api/admin/roles/${superRole.id}`, {
    method: 'PUT',
    body: { name: 'x', key: '1BAD', description: '' },
  });
  assert.equal(badKey.status, 403);
  assert.equal(badKey.body.error.code, 'role_protected');
  const badStatus = await writeCall(admin, `/api/admin/roles/${superRole.id}/status`, {
    body: { status: 'banned' },
  });
  assert.equal(badStatus.status, 403);
  assert.equal(badStatus.body.error.code, 'role_protected');
  const badKeys = await writeCall(admin, `/api/admin/roles/${superRole.id}/permissions`, {
    method: 'PUT',
    body: { permissionKeys: ['ghost:hack'] },
  });
  assert.equal(badKeys.status, 403);
  assert.equal(badKeys.body.error.code, 'role_protected');

  // ③ 全部 4 次拒绝均留审计（修复前保留 key 路径无审计）
  const audit = await admin.request('/api/admin/audit-events?pageSize=50');
  const onSuper = audit.body.items.filter(
    (i) => i.targetId === String(superRole.id) && i.reason === 'role_protected' && i.result === 'denied',
  );
  assert.equal(onSuper.length, 4, '针对 super_admin 的 4 次写企图全部留痕');
  assert.ok(onSuper.some((i) => i.action === 'role.update'));
  assert.ok(onSuper.some((i) => i.action === 'role.status'));
  assert.ok(onSuper.some((i) => i.action === 'role.assign_permissions'));
  // ④ 保护有效：角色未被修改
  const after = await admin.request(`/api/admin/roles/${superRole.id}`);
  assert.equal(after.body.role.name, '超级管理员');
  assert.equal(after.body.role.status, 'active');

  // ⑤ 非内置角色行为不变：非法载荷仍 400、合法载荷正常
  const created = await writeCall(admin, '/api/admin/roles', { body: { name: '普通角色', key: 'plain_role', description: '' } });
  const invalid = await writeCall(admin, `/api/admin/roles/${created.body.role.id}`, {
    method: 'PUT',
    body: { name: '', key: 'plain_role', description: '' },
  });
  assert.equal(invalid.status, 400, '非内置角色非法载荷仍走 400 结构校验');
  const valid = await writeCall(admin, `/api/admin/roles/${created.body.role.id}`, {
    method: 'PUT',
    body: { name: '普通角色改', key: 'plain_role', description: '' },
  });
  assert.equal(valid.status, 200, '非内置角色合法编辑不受影响');

  // ⑥ 不存在角色：404 先于载荷校验（路径寻址不依赖请求体）
  const missing = await writeCall(admin, '/api/admin/roles/99999', {
    method: 'PUT',
    body: { name: '', key: 'x', description: '' },
  });
  assert.equal(missing.status, 404);
});
