/**
 * 测试工程师独立验证（NEXORA-RBAC-011 / 测试节点）：
 * 由测试工程师在研发交付（0e7915b）基础上独立编写的对抗性验证，断言不复制研发用例实现，
 * 聚焦验收标准中最高风险路径：端到端闭环、401/403 语义、CSRF、防提权、最后超管并发、
 * 撤权即时生效、禁用双保险、原子替换、注入与审计脱敏、分页边界、冻结契约。
 * 全部数据仅存于 server-harness 的隔离临时 SQLite（NFR-05），用户均为虚构。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestServer } from './server-harness.mjs';
import { login, registerAndBootstrap, registerAndLogin, registerBootstrapLogin, writeCall } from './admin-helpers.mjs';

const CSRF = { 'X-Nexora-CSRF': '1' };
const ADMIN_WRITE_ENDPOINTS = [
  ['POST', '/api/admin/users/__nobody__/status', { status: 'disabled' }],
  ['PUT', '/api/admin/users/__nobody__/roles', { roleIds: [] }],
  ['POST', '/api/admin/roles', { name: '探针角色', key: 'probe_role', description: '' }],
  ['PUT', '/api/admin/roles/999999', { name: 'x', key: 'probe_x', description: '' }],
  ['POST', '/api/admin/roles/999999/status', { status: 'disabled' }],
  ['DELETE', '/api/admin/roles/999999', undefined],
  ['PUT', '/api/admin/roles/999999/permissions', { permissionKeys: [] }],
];

/** 建立授权素材：创建角色并分配权限、绑定用户，返回 {roleId}。 */
async function setupRoleWithPerms(admin, { key, name, perms, targetUser }) {
  const created = await writeCall(admin, '/api/admin/roles', { method: 'POST', body: { name, key, description: '独立验证' } });
  assert.equal(created.status, 201, `建角色 ${key} 应 201，实际 ${created.status} ${created.rawBody}`);
  const roleId = created.body.role.id;
  const granted = await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: perms } });
  assert.equal(granted.status, 200, `角色 ${key} 授权应 200，实际 ${granted.status} ${granted.rawBody}`);
  if (targetUser) {
    const bound = await writeCall(admin, `/api/admin/users/${targetUser}/roles`, { method: 'PUT', body: { roleIds: [roleId] } });
    assert.equal(bound.status, 200, `绑定 ${targetUser} 应 200，实际 ${bound.status} ${bound.rawBody}`);
  }
  return roleId;
}

test('IND-01 F-01 端到端闭环：建角色→授权→绑用户→用户登录→获准200/未获准403→撤权下一请求403（AC-05/07/23）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    await registerAndLogin(server, 'ind_user_a', 'Passw0rd!123');

    // 新建用户零权限：注册响应无角色字段，直调管理 API 403（AC-07）
    const fresh = await server.client().request('/api/register', { method: 'POST', body: { username: 'ind_user_new', password: 'Passw0rd!123' } });
    assert.equal(fresh.status, 201);
    assert.deepEqual(Object.keys(fresh.body.user), ['username'], '注册响应不得含角色字段');
    const freshClient = await registerAndLogin(server, 'ind_user_b', 'Passw0rd!123');
    assert.equal((await freshClient.request('/api/admin/users')).status, 403);
    assert.deepEqual((await freshClient.request('/api/me/permissions')).body.permissions, []);

    // 建角色授 user:read + permission:read，绑给 ind_user_a
    const roleId = await setupRoleWithPerms(admin, {
      key: 'ind_ops', name: '独立运营', perms: ['user:read', 'permission:read'], targetUser: 'ind_user_a',
    });

    // 用户登录态：有效权限为并集
    const userA = await registerAndLogin(server, 'ind_user_a', 'Passw0rd!123'); // 新会话
    const perms = (await userA.request('/api/me/permissions')).body.permissions;
    assert.deepEqual(perms, ['permission:read', 'user:read'], '有效权限应为已启用角色并集（排序去重）');
    assert.equal((await userA.request('/api/admin/users')).status, 200, '并集内 API 应 200');
    assert.equal((await userA.request('/api/admin/permissions')).status, 200);
    assert.equal((await userA.request('/api/admin/roles')).status, 403, '并集外 API 应 403');
    assert.equal((await userA.request('/api/admin/audit-events')).status, 403);

    // 撤权（解绑角色）后同一 session 下一请求立即 403，无需重新登录（AC-23）
    const unbound = await writeCall(admin, '/api/admin/users/ind_user_a/roles', { method: 'PUT', body: { roleIds: [] } });
    assert.equal(unbound.status, 200);
    assert.equal((await userA.request('/api/admin/users')).status, 403, '撤权后下一请求即 403');
    assert.deepEqual((await userA.request('/api/me/permissions')).body.permissions, []);

    // 重新绑定后禁用角色：下一请求失去权限（AC-06）
    await writeCall(admin, '/api/admin/users/ind_user_a/roles', { method: 'PUT', body: { roleIds: [roleId] } });
    assert.equal((await userA.request('/api/admin/users')).status, 200);
    await writeCall(admin, `/api/admin/roles/${roleId}/status`, { method: 'POST', body: { status: 'disabled' } });
    assert.equal((await userA.request('/api/admin/users')).status, 403, '禁用角色后下一请求即 403');
  } finally {
    await server.close();
  }
});

test('IND-02 401/403 语义矩阵：14 端点未登录 401、普通登录 403，不混用（AC-24）', async () => {
  const server = await startTestServer();
  try {
    const anon = server.client();
    const plain = await registerAndLogin(server, 'ind_plain', 'Passw0rd!123');
    const readPaths = [
      '/api/admin/users', '/api/admin/users/ind_plain', '/api/admin/roles', '/api/admin/roles/enabled',
      '/api/admin/roles/1', '/api/admin/permissions', '/api/admin/audit-events',
    ];
    for (const path of readPaths) {
      const a = await anon.request(path);
      assert.equal(a.status, 401, `未登录 GET ${path} 应 401，实际 ${a.status}`);
      assert.equal(a.body.error.code, 'unauthorized');
      const p = await plain.request(path);
      assert.equal(p.status, 403, `无权限 GET ${path} 应 403，实际 ${p.status}`);
      assert.equal(p.body.error.code, 'forbidden');
    }
    for (const [method, path, body] of ADMIN_WRITE_ENDPOINTS) {
      const a = await anon.request(path, { method, body, headers: CSRF });
      assert.equal(a.status, 401, `未登录 ${method} ${path} 应 401，实际 ${a.status}`);
      const p = await plain.request(path, { method, body, headers: CSRF });
      assert.equal(p.status, 403, `无权限 ${method} ${path} 应 403，实际 ${p.status}`);
      assert.equal(p.body.error.code, 'forbidden');
    }
  } finally {
    await server.close();
  }
});

test('IND-03 CSRF：全部写端点缺失/错误头 → 403 csrf_protection，即使会话与权限合法（AC-30）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    for (const [method, path, body] of ADMIN_WRITE_ENDPOINTS) {
      const missing = await admin.request(path, { method, body });
      assert.equal(missing.status, 403, `${method} ${path} 缺头应 403，实际 ${missing.status}`);
      assert.equal(missing.body.error.code, 'csrf_protection');
      const wrong = await admin.request(path, { method, body, headers: { 'X-Nexora-CSRF': 'yes' } });
      assert.equal(wrong.status, 403, `${method} ${path} 错头应 403`);
      assert.equal(wrong.body.error.code, 'csrf_protection');
    }
    // 读端点不要求 CSRF 头
    assert.equal((await admin.request('/api/admin/users')).status, 200);
  } finally {
    await server.close();
  }
});

test('IND-04 伪造身份/角色/permission 字段被忽略，服务端以会话与库为准（AC-25）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    const plain = await registerAndLogin(server, 'ind_plain', 'Passw0rd!123');
    // 伪造超管身份字段直调管理 API：仍按真实权限 403
    const forged = await plain.request('/api/admin/users', {
      method: 'GET',
      headers: { 'X-User-Role': 'super_admin', 'X-Permissions': 'user:read' },
    });
    assert.equal(forged.status, 403);
    // 登录请求携带伪造角色字段：响应不得回显，权限不变
    const res = await server.client().request('/api/login', {
      method: 'POST',
      body: { username: 'ind_plain', password: 'Passw0rd!123', roles: ['super_admin'], isSuperAdmin: true, permissions: ['*'] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['user', 'session'], '登录响应形状冻结');
    // 管理写请求体携带伪造操作者字段：目标只来自路径，操作者只来自会话
    const created = await writeCall(admin, '/api/admin/roles', {
      method: 'POST',
      body: { name: '审计归属', key: 'ind_forge', description: '', actorUsername: 'ghost', actorId: 1 },
    });
    assert.equal(created.status, 201);
    const audit = await admin.request('/api/admin/audit-events?action=role.create');
    const row = audit.body.items.find((i) => i.targetLabel === '审计归属');
    assert.equal(row.actorUsername, 'ind_admin', '审计操作者必须来自会话而非请求体');
  } finally {
    await server.close();
  }
});

test('IND-05 授权子集约束：普通授权者不可授予超出自身的权限（AC-27，D-03）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    // 权限管理员：仅 role:read + role:assign_permissions + user:assign_roles
    await registerAndLogin(server, 'ind_mgr', 'Passw0rd!123');
    const mgrRoleId = await setupRoleWithPerms(admin, {
      key: 'ind_mgr_role', name: '权限管理员',
      perms: ['role:read', 'role:assign_permissions', 'user:assign_roles'], targetUser: 'ind_mgr',
    });
    void mgrRoleId;
    const mgr = await registerAndLogin(server, 'ind_mgr', 'Passw0rd!123');

    // 自身权限内的授予：允许
    const okRole = await writeCall(mgr, '/api/admin/roles', { method: 'POST', body: { name: 'x', key: 'ind_x', description: '' } });
    assert.equal(okRole.status, 403, 'mgr 无 role:create，建角色应 403');
    const wideRoleId = await setupRoleWithPerms(admin, { key: 'ind_wide', name: '宽权限', perms: ['user:read', 'audit:read'] });
    const own = await writeCall(mgr, `/api/admin/roles/${wideRoleId}/permissions`, { method: 'PUT', body: { permissionKeys: ['user:assign_roles'] } });
    assert.equal(own.status, 200, '移除超范围权限并保留自身子集应允许');

    // 越权勾选角色权限：403 grant_out_of_scope + 审计
    const denied = await writeCall(mgr, `/api/admin/roles/${wideRoleId}/permissions`, { method: 'PUT', body: { permissionKeys: ['user:assign_roles', 'audit:read'] } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'grant_out_of_scope');
    assert.match(denied.body.error.message, /audit:read/);
    const after = await mgr.request(`/api/admin/roles/${wideRoleId}`);
    assert.deepEqual(after.body.role.permissionKeys, ['user:assign_roles'], '被拒后权限集不得变化（无部分成功）');

    // 越权分配角色给用户：403
    const superWideId = await setupRoleWithPerms(admin, { key: 'ind_wide2', name: '更宽', perms: ['user:read'] });
    const deniedAssign = await writeCall(mgr, '/api/admin/users/ind_plain_x/roles', { method: 'PUT', body: { roleIds: [superWideId] } });
    assert.equal(deniedAssign.status, 404, '目标不存在应先 404');
    await registerAndLogin(server, 'ind_plain_x', 'Passw0rd!123');
    const deniedAssign2 = await writeCall(mgr, '/api/admin/users/ind_plain_x/roles', { method: 'PUT', body: { roleIds: [superWideId] } });
    assert.equal(deniedAssign2.status, 403);
    assert.equal(deniedAssign2.body.error.code, 'grant_out_of_scope');

    // 拒绝事件留痕（AC-27 + AC-32）
    const audit = await admin.request('/api/admin/audit-events?result=denied&actor=ind_mgr');
    const reasons = audit.body.items.map((i) => i.reason);
    assert.ok(reasons.includes('grant_out_of_scope'), 'grant_out_of_scope 拒绝应留痕');
  } finally {
    await server.close();
  }
});

test('IND-06 super_admin 保护矩阵：仅超管可管超管绑定；超管本体任何人不可改（AC-12/26/29）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    await registerAndLogin(server, 'ind_mgr', 'Passw0rd!123');
    await setupRoleWithPerms(admin, {
      key: 'ind_full_mgr', name: '全量非超管', targetUser: 'ind_mgr',
      perms: ['user:read', 'user:status', 'user:assign_roles', 'role:read', 'role:create', 'role:update', 'role:delete', 'role:assign_permissions', 'permission:read', 'audit:read'],
    });
    const mgr = await registerAndLogin(server, 'ind_mgr', 'Passw0rd!123'); // 拥有全部 10 权限但非超管
    const roles = (await admin.request('/api/admin/roles?q=super_admin')).body.items;
    const superRole = roles.find((r) => r.key === 'super_admin');

    // 非超管分配/撤销 super_admin 绑定 → 403 super_admin_required + 审计
    const grantSuper = await writeCall(mgr, '/api/admin/users/ind_mgr/roles', { method: 'PUT', body: { roleIds: [superRole.id] } });
    assert.equal(grantSuper.status, 403);
    assert.equal(grantSuper.body.error.code, 'super_admin_required');
    // 非超管禁用超管成员 → 403
    const disableSuper = await writeCall(mgr, '/api/admin/users/ind_admin/status', { method: 'POST', body: { status: 'disabled' } });
    assert.equal(disableSuper.status, 403);
    assert.equal(disableSuper.body.error.code, 'super_admin_required');
    // 即使操作者是超管，super_admin 角色本体仍不可编辑/启停/删除/改权限（P-01，契约 403 role_protected）
    // ① 保留 key 仅改名的普通编辑（最自然的直连尝试）——契约与 AC-12 要求 403 role_protected 且留审计
    const renameOnly = await writeCall(admin, `/api/admin/roles/${superRole.id}`, {
      method: 'PUT', body: { name: '改名尝试', key: 'super_admin', description: '' },
    });
    assert.equal(renameOnly.status, 403, `超管本体改名应 403 role_protected，实际 ${renameOnly.status} ${renameOnly.rawBody}`);
    assert.equal(renameOnly.body.error.code, 'role_protected');
    // ② 其余三种写操作（合法载荷）→ 403 role_protected
    for (const [method, path, body] of [
      ['POST', `/api/admin/roles/${superRole.id}/status`, { status: 'disabled' }],
      ['DELETE', `/api/admin/roles/${superRole.id}`, undefined],
      ['PUT', `/api/admin/roles/${superRole.id}/permissions`, { permissionKeys: ['user:read'] }],
    ]) {
      const res = await writeCall(admin, path, { method, body });
      assert.equal(res.status, 403, `超管本体 ${method} 应 403，实际 ${res.status}`);
      assert.equal(res.body.error.code, 'role_protected');
    }
    // ③ 上述拒绝全部留审计（AC-12）
    const superAudit = await admin.request('/api/admin/audit-events?result=denied&pageSize=50');
    const onSuper = superAudit.body.items.filter((i) => i.targetId === String(superRole.id) && i.reason === 'role_protected');
    assert.ok(onSuper.length >= 4, `针对 super_admin 本体的 4 次拒绝均应留审计，实际 ${onSuper.length} 条`);
    // 保留字：任何创建 key=super_admin → 400
    const reserved = await writeCall(admin, '/api/admin/roles', { method: 'POST', body: { name: 'x', key: 'super_admin', description: '' } });
    assert.equal(reserved.status, 400);
    assert.equal(reserved.body.error.code, 'invalid_params');
    // 拒绝均留痕
    const audit = await admin.request('/api/admin/audit-events?result=denied');
    const reasons = new Set(audit.body.items.map((i) => i.reason));
    assert.ok(reasons.has('super_admin_required') && reasons.has('role_protected'));
  } finally {
    await server.close();
  }
});

test('IND-07 最后一名启用 super_admin：禁用/撤权被拒；并发互相禁用至多一单成功（AC-28）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    const roles = (await admin.request('/api/admin/roles?q=super_admin')).body.items;
    const superRole = roles.find((r) => r.key === 'super_admin');
    // 仅剩一名超管：自我禁用 → 409；撤销自身绑定 → 409
    const selfDisable = await writeCall(admin, '/api/admin/users/ind_admin/status', { method: 'POST', body: { status: 'disabled' } });
    assert.equal(selfDisable.status, 409);
    assert.equal(selfDisable.body.error.code, 'last_super_admin');
    const selfRevoke = await writeCall(admin, '/api/admin/users/ind_admin/roles', { method: 'PUT', body: { roleIds: [] } });
    assert.equal(selfRevoke.status, 409);
    // 提升第二名超管后，并发互相禁用：至多一单成功且系统始终 ≥1 名启用超管
    await registerAndBootstrap(server, 'ind_admin2', 'Passw0rd!123');
    const admin2 = server.client();
    await login(admin2, 'ind_admin2', 'Passw0rd!123');
    const [r1, r2] = await Promise.all([
      writeCall(admin, '/api/admin/users/ind_admin2/status', { method: 'POST', body: { status: 'disabled' } }),
      writeCall(admin2, '/api/admin/users/ind_admin/status', { method: 'POST', body: { status: 'disabled' } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    const successes = statuses.filter((s) => s === 200).length;
    assert.ok(successes <= 1, `并发双禁至多一单成功，实际 ${JSON.stringify(statuses)}`);
    assert.ok(statuses.some((s) => s === 409 || s === 401), `另一单应 409 或 401，实际 ${JSON.stringify(statuses)}`);
    const list = await admin.request('/api/admin/users?pageSize=50');
    const supers = [];
    for (const u of list.body.items) {
      if (u.status === 'active' && u.roles.some((r) => r.key === 'super_admin' && r.status === 'active')) supers.push(u.username);
    }
    assert.ok(supers.length >= 1, '系统必须始终保留至少一名启用 super_admin');
  } finally {
    await server.close();
  }
});

test('IND-08 用户禁用双保险：旧会话 401、启用不复活、禁用登录与密码错误逐字节一致（AC-22）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    const victim = await registerAndLogin(server, 'ind_victim', 'Passw0rd!123');
    assert.equal((await victim.request('/api/me')).status, 200);
    const disabled = await writeCall(admin, '/api/admin/users/ind_victim/status', { method: 'POST', body: { status: 'disabled' } });
    assert.equal(disabled.status, 200);
    assert.equal((await victim.request('/api/me')).status, 401, '禁用后旧会话下一请求 401');
    assert.equal((await victim.request('/api/resource')).status, 401);
    // 重新启用：旧会话不复活
    await writeCall(admin, '/api/admin/users/ind_victim/status', { method: 'POST', body: { status: 'active' } });
    assert.equal((await victim.request('/api/me')).status, 401, '重新启用后旧会话仍 401');
    // 禁用期登录与密码错误逐字节一致（防枚举，AD-05）
    await writeCall(admin, '/api/admin/users/ind_victim/status', { method: 'POST', body: { status: 'disabled' } });
    const disabledLogin = await server.client().request('/api/login', { method: 'POST', body: { username: 'ind_victim', password: 'Passw0rd!123' } });
    const wrongPassword = await server.client().request('/api/login', { method: 'POST', body: { username: 'ind_victim', password: 'WrongPass!99' } });
    const noUser = await server.client().request('/api/login', { method: 'POST', body: { username: 'ind_no_user', password: 'Passw0rd!123' } });
    assert.equal(disabledLogin.status, 401);
    assert.equal(disabledLogin.rawBody, wrongPassword.rawBody, '禁用登录须与密码错误逐字节一致');
    assert.equal(disabledLogin.rawBody, noUser.rawBody, '禁用登录须与用户不存在逐字节一致');
    // 重新启用后可重新登录
    await writeCall(admin, '/api/admin/users/ind_victim/status', { method: 'POST', body: { status: 'active' } });
    assert.equal((await server.client().request('/api/login', { method: 'POST', body: { username: 'ind_victim', password: 'Passw0rd!123' } })).status, 200);
  } finally {
    await server.close();
  }
});

test('IND-09 角色权限原子替换与未知/重复输入整体拒绝（AC-08/19）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    const roleId = await setupRoleWithPerms(admin, { key: 'ind_atomic', name: '原子', perms: ['user:read'] });
    // 原子替换：提交 [role:read] 后权限集精确等于 [role:read]
    const replaced = await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: ['role:read'] } });
    assert.deepEqual(replaced.body.role.permissionKeys, ['role:read']);
    // 未知 key：400 + fields 列出清单，权限集不变
    const unknown = await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: ['role:read', 'ghost:hack', 'user:fly'] } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error.fields.permissionKeys, /ghost:hack/);
    assert.match(unknown.body.error.fields.permissionKeys, /user:fly/);
    assert.deepEqual((await admin.request(`/api/admin/roles/${roleId}`)).body.role.permissionKeys, ['role:read']);
    // 重复 key：400；非字符串/非数组：400；空数组合法（清空）
    assert.equal((await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: ['user:read', 'user:read'] } })).status, 400);
    assert.equal((await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: ['user:read', 1] } })).status, 400);
    assert.equal((await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: 'user:read' } })).status, 400);
    const cleared = await writeCall(admin, `/api/admin/roles/${roleId}/permissions`, { method: 'PUT', body: { permissionKeys: [] } });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.role.permissionKeys, []);
  } finally {
    await server.close();
  }
});

test('IND-10 角色冲突语义：key 冲突 409；绑定中删除 409 含数量与示例，解绑后可删（AC-10/11）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    const roleId = await setupRoleWithPerms(admin, { key: 'ind_conflict', name: '冲突角色', perms: [] });
    const dup = await writeCall(admin, '/api/admin/roles', { method: 'POST', body: { name: '同名', key: 'ind_conflict', description: '' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'role_key_taken');
    for (const name of ['u_bind1', 'u_bind2']) await registerAndLogin(server, name, 'Passw0rd!123');
    const u2Roles = (await admin.request('/api/admin/users/u_bind2')).body.user.roles;
    await writeCall(admin, '/api/admin/users/u_bind1/roles', { method: 'PUT', body: { roleIds: [roleId] } });
    await writeCall(admin, '/api/admin/users/u_bind2/roles', { method: 'PUT', body: { roleIds: [roleId] } });
    const conflict = await writeCall(admin, `/api/admin/roles/${roleId}`, { method: 'DELETE' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'role_in_use');
    assert.match(conflict.body.error.message, /2 个用户/);
    assert.match(conflict.body.error.message, /u_bind1/);
    assert.equal((await admin.request(`/api/admin/roles/${roleId}`)).status, 200, '冲突时角色不得被删除');
    await writeCall(admin, '/api/admin/users/u_bind1/roles', { method: 'PUT', body: { roleIds: [] } });
    await writeCall(admin, '/api/admin/users/u_bind2/roles', { method: 'PUT', body: { roleIds: [] } });
    const deleted = await writeCall(admin, `/api/admin/roles/${roleId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal((await admin.request(`/api/admin/roles/${roleId}`)).status, 404);
    void u2Roles;
  } finally {
    await server.close();
  }
});

test('IND-11 注入防线：搜索 LIKE 转义与参数化；XSS 载荷以纯文本存取（AC-31）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    await registerAndLogin(server, 'ind_victim', 'Passw0rd!123');
    // SQL 注入特征：LIKE 通配符须按字面处理
    const likeAll = await admin.request(`/api/admin/users?q=${encodeURIComponent('%')}`);
    assert.equal(likeAll.status, 200);
    assert.equal(likeAll.body.total, 0, '%% 不应匹配全部用户（LIKE 转义）');
    const inject = await admin.request(`/api/admin/users?q=${encodeURIComponent("' OR '1'='1")}`);
    assert.equal(inject.status, 200);
    assert.equal(inject.body.total, 0);
    // XSS 载荷作为角色名（长度须在 1–50 合法范围内）：入库/回读为纯文本
    const payload = '<script>alert(1)</script><b>x</b>';
    assert.ok(payload.length <= 50);
    const created = await writeCall(admin, '/api/admin/roles', { method: 'POST', body: { name: payload, key: 'ind_xss', description: payload } });
    assert.equal(created.status, 201);
    const detail = await admin.request(`/api/admin/roles/${created.body.role.id}`);
    assert.equal(detail.body.role.name, payload, '回读应为纯文本原文');
    assert.equal(detail.body.role.description, payload);
    // 审计 detail 不含凭据键（白名单）
    const audit = await admin.request('/api/admin/audit-events?pageSize=50');
    const raw = JSON.stringify(audit.body);
    assert.ok(!raw.includes('Passw0rd!123'), '审计输出不得含密码');
    assert.ok(!raw.includes('nexora_session'), '审计输出不得含 Cookie 名值');
  } finally {
    await server.close();
  }
});

test('IND-12 审计筛选五维与内容完整：操作者/对象/动作/时间/结果（AC-32）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    const before = Date.now() - 1000;
    const roleId = await setupRoleWithPerms(admin, { key: 'ind_audit', name: '审计对象', perms: ['user:read'] });
    const after = Date.now() + 1000;
    const byAction = await admin.request('/api/admin/audit-events?action=role.assign_permissions');
    assert.ok(byAction.body.items.length >= 1);
    assert.ok(byAction.body.items.every((i) => i.action === 'role.assign_permissions'));
    const row = byAction.body.items[0];
    for (const field of ['id', 'actorUsername', 'action', 'targetType', 'targetId', 'targetLabel', 'result', 'detail', 'createdAt']) {
      assert.ok(field in row, `审计行缺字段 ${field}`);
    }
    assert.equal(row.actorUsername, 'ind_admin');
    assert.equal(row.result, 'success');
    assert.deepEqual(row.detail.after.permissionKeys, ['user:read'], '前后差异须完整');
    const byTime = await admin.request(`/api/admin/audit-events?from=${before}&to=${after}&pageSize=50`);
    assert.ok(byTime.body.items.length >= 2);
    const outOfRange = await admin.request(`/api/admin/audit-events?to=${before - 10000}`);
    assert.equal(outOfRange.body.total, 0);
    const byTarget = await admin.request(`/api/admin/audit-events?target=${encodeURIComponent('审计对象')}`);
    assert.ok(byTarget.body.items.length >= 1);
    // 非法筛选参数 400
    assert.equal((await admin.request('/api/admin/audit-events?action=hack')).status, 400);
    assert.equal((await admin.request('/api/admin/audit-events?from=abc')).status, 400);
    void roleId;
  } finally {
    await server.close();
  }
});

test('IND-13 多角色并集与禁用叠加：覆盖判定精确（AC-05/06）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    await registerAndLogin(server, 'ind_multi', 'Passw0rd!123');
    const r1 = await setupRoleWithPerms(admin, { key: 'ind_r1', name: '角色一', perms: ['user:read'] });
    const r2 = await setupRoleWithPerms(admin, { key: 'ind_r2', name: '角色二', perms: ['role:read', 'permission:read'] });
    await writeCall(admin, '/api/admin/users/ind_multi/roles', { method: 'PUT', body: { roleIds: [r1, r2] } });
    const user = await registerAndLogin(server, 'ind_multi', 'Passw0rd!123');
    assert.deepEqual((await user.request('/api/me/permissions')).body.permissions, ['permission:read', 'role:read', 'user:read']);
    // 禁用一个角色：另一角色权限不受影响
    await writeCall(admin, `/api/admin/roles/${r1}/status`, { method: 'POST', body: { status: 'disabled' } });
    assert.equal((await user.request('/api/admin/users')).status, 403);
    assert.equal((await user.request('/api/admin/roles')).status, 200, '其他启用角色权限不受影响');
    // 重新启用即时恢复
    await writeCall(admin, `/api/admin/roles/${r1}/status`, { method: 'POST', body: { status: 'active' } });
    assert.equal((await user.request('/api/admin/users')).status, 200, '角色恢复后下一请求即恢复');
  } finally {
    await server.close();
  }
});

test('IND-14 分页与查询边界：page/pageSize/q 非法 400，越界页空集（AC-03 边界）', async () => {
  const server = await startTestServer();
  try {
    const admin = await registerBootstrapLogin(server, 'ind_admin', 'Passw0rd!123');
    for (const q of ['page=0', 'page=-1', 'page=1.5', 'page=abc', 'pageSize=0', 'pageSize=51', `q=${'x'.repeat(65)}`]) {
      const res = await admin.request(`/api/admin/users?${q}`);
      assert.equal(res.status, 400, `${q} 应 400，实际 ${res.status}`);
      assert.equal(res.body.error.code, 'invalid_params');
    }
    const out = await admin.request('/api/admin/users?page=999&pageSize=50');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.items, []);
    // pageSize 上限 50 合法
    assert.equal((await admin.request('/api/admin/users?pageSize=50')).status, 200);
  } finally {
    await server.close();
  }
});

test('IND-15 既有契约冻结：/api/me 响应形状逐字节不变，health 暴露 version（AC-37）', async () => {
  const server = await startTestServer({ commitSha: 'ind-test-sha' });
  try {
    const client = await registerAndLogin(server, 'ind_plain', 'Passw0rd!123');
    const me = await client.request('/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(me.body).sort(), ['session', 'user']);
    assert.deepEqual(Object.keys(me.body.user), ['username']);
    assert.deepEqual(Object.keys(me.body.session), ['expiresAt']);
    const health = await server.client().request('/api/health');
    assert.deepEqual(health.body, { status: 'ok', version: 'ind-test-sha' });
    // 注销幂等与清 Cookie 口径（契约：POST 须 JSON Content-Type，故带空 JSON 体）
    const out1 = await client.request('/api/logout', { method: 'POST', body: {} });
    const out2 = await client.request('/api/logout', { method: 'POST', body: {} });
    assert.equal(out1.status, 200);
    assert.equal(out2.status, 200);
    assert.match(out2.setCookie ?? '', /Max-Age=0/);
  } finally {
    await server.close();
  }
});
