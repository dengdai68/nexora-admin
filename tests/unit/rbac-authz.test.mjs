/**
 * T-03 鉴权层单测（AC-05/06/22/24、AD-05、R-01/R-02/R-06、D-02/D-03）：
 * 多角色并集、禁用角色即时剔除、未知 key 永不出现、禁用用户 resolveSession→null、
 * 禁用登录与密码错误逐字节一致、授权子集边界、最后一名启用 super_admin 计数保护。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMigratedDatabase } from '../../server/migrations.mjs';
import { createAuthService, INVALID_CREDENTIALS } from '../../server/auth-service.mjs';
import { fakeClock } from '../../server/clock.mjs';
import {
  insertRole,
  insertUser,
  replaceRolePermissions,
  replaceUserRoles,
  updateRoleStatus,
  updateUserStatus,
} from '../../server/db.mjs';
import {
  assertCanGrant,
  guardLastSuperAdmin,
  isSuperAdmin,
  resolveEffectivePermissions,
} from '../../server/authz.mjs';
import { SUPER_ADMIN_ROLE_KEY } from '../../server/permissions.mjs';
import { createAuditService } from '../../server/audit-service.mjs';
import { createAdminService } from '../../server/admin-service.mjs';

function withEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-authz-'));
  const db = openMigratedDatabase(join(dir, 'test.db'));
  const clock = fakeClock(1_700_000_000_000);
  const auth = createAuthService({ db, clock, sessionTtlMs: 86_400_000 });
  try {
    return fn({ db, clock, auth });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 快速造数：用户 + 自定义角色（含权限）+ 绑定。 */
function setupUserWithRoles(db, username, roleDefs) {
  const userId = insertUser(db, { username, passwordHash: 'scrypt:stub', createdAt: 1700000000000 });
  const roleIds = roleDefs.map((def) => {
    const roleId = insertRole(db, { key: def.key, name: def.name ?? def.key, description: '', now: 1700000000000 });
    replaceRolePermissions(db, roleId, def.keys);
    return roleId;
  });
  replaceUserRoles(db, userId, roleIds, null, 1700000000000);
  return { userId, roleIds };
}

test('authz: 多角色有效权限为并集（AC-05）', () =>
  withEnv(({ db }) => {
    const { userId } = setupUserWithRoles(db, 'union_user', [
      { key: 'role_a', keys: ['user:read'] },
      { key: 'role_b', keys: ['role:read', 'role:create'] },
    ]);
    const perms = resolveEffectivePermissions(db, userId);
    assert.deepEqual([...perms].sort(), ['role:create', 'role:read', 'user:read']);
  }));

test('authz: 禁用角色即时从并集中剔除，其他启用角色不受影响（AC-06）', () =>
  withEnv(({ db }) => {
    const { userId, roleIds } = setupUserWithRoles(db, 'disable_role_user', [
      { key: 'role_a', keys: ['user:read'] },
      { key: 'role_b', keys: ['role:read'] },
    ]);
    updateRoleStatus(db, roleIds[0], 'disabled', 1700000000001);
    const perms = resolveEffectivePermissions(db, userId);
    assert.deepEqual([...perms], ['role:read'], '禁用角色贡献立即消失，无需重新登录');
  }));

test('authz: 目录外 key 永不出现（R-02 默认拒绝）', () =>
  withEnv(({ db }) => {
    const { userId } = setupUserWithRoles(db, 'plain_user', [{ key: 'role_a', keys: ['user:read'] }]);
    const perms = resolveEffectivePermissions(db, userId);
    assert.equal(perms.has('ghost:hack'), false);
    assert.equal(perms.has('super_admin'), false, '分组/角色名不是权限');
  }));

test('authz: 新注册用户默认无任何权限（R-03）', () =>
  withEnv(({ db, auth }) => {
    auth.register({ username: 'newbie', password: 'Password@123' });
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get('newbie');
    const perms = resolveEffectivePermissions(db, Number(user.id));
    assert.equal(perms.size, 0);
  }));

test('authz: 禁用用户 resolveSession → null；重新启用不复活已撤销会话（D-02 全链路，AC-22）', () =>
  withEnv(({ db, auth, clock }) => {
    // 权威禁用路径在领域服务层（禁用即事务内撤销全部会话），此处走 admin-service 而非裸 SQL
    const audit = createAuditService({ db, clock });
    const admin = createAdminService({ db, clock, auditService: audit });
    const operator = { id: 900, username: 'root_admin', permissions: new Set(), isSuperAdmin: true };
    auth.register({ username: 'blocked', password: 'Password@123' });
    const { token } = auth.login({ username: 'blocked', password: 'Password@123' });
    assert.ok(auth.resolveSession(token), '禁用前会话有效');
    const disabled = admin.setUserStatus(operator, 'blocked', 'disabled');
    assert.equal(disabled.ok, true);
    assert.equal(auth.resolveSession(token), null, '禁用后旧会话立即失效');
    const enabled = admin.setUserStatus(operator, 'blocked', 'active');
    assert.equal(enabled.ok, true);
    assert.equal(auth.resolveSession(token), null, '重新启用不复活已撤销会话（须重新登录）');
  }));

test('authz: 禁用用户登录与密码错误逐字节一致（AD-05 防枚举）', () =>
  withEnv(({ db, auth }) => {
    auth.register({ username: 'blocked2', password: 'Password@123' });
    updateUserStatus(db, 'blocked2', 'disabled');
    const disabledLogin = auth.login({ username: 'blocked2', password: 'Password@123' });
    const wrongPass = auth.login({ username: 'blocked2', password: 'WrongPass@1' });
    assert.deepEqual(disabledLogin, INVALID_CREDENTIALS);
    assert.deepEqual(disabledLogin, wrongPass, '禁用与密码错误返回逐字节一致');
    assert.deepEqual(disabledLogin, auth.login({ username: 'ghost', password: 'Password@123' }), '与不存在用户同样一致');
  }));

test('authz: 授权子集校验边界（D-03）——空新增/恰好相等/超集', () => {
  const actor = new Set(['user:read', 'role:read']);
  assert.deepEqual(assertCanGrant(actor, []), { ok: true }, '空新增恒允许');
  assert.deepEqual(assertCanGrant(actor, ['user:read', 'role:read']), { ok: true }, '恰好相等允许');
  const over = assertCanGrant(actor, ['user:read', 'audit:read']);
  assert.equal(over.ok, false);
  assert.deepEqual(over.missing, ['audit:read'], '越权 key 清单（排序）');
});

test('authz: isSuperAdmin 与最后一名启用 super_admin 计数保护（R-06）', () =>
  withEnv(({ db }) => {
    const superRole = db.prepare('SELECT id FROM roles WHERE key = ?').get(SUPER_ADMIN_ROLE_KEY);
    const superRoleId = Number(superRole.id);
    const admin1 = insertUser(db, { username: 'admin1', passwordHash: 'x', createdAt: 1 });
    const admin2 = insertUser(db, { username: 'admin2', passwordHash: 'x', createdAt: 1 });
    replaceUserRoles(db, admin1, [superRoleId], null, 1);
    replaceUserRoles(db, admin2, [superRoleId], null, 1);
    assert.equal(isSuperAdmin(db, admin1), true);
    assert.deepEqual(guardLastSuperAdmin(db, { excludeUserId: admin1 }), { ok: true }, '还有 admin2，允许移除 admin1');
    replaceUserRoles(db, admin2, [], null, 1); // 移除 admin2 → 仅剩 admin1
    const guard = guardLastSuperAdmin(db, { excludeUserId: admin1 });
    assert.equal(guard.ok, false, '排除最后一名后计数为 0 → 拒绝');
    assert.equal(guard.code, 'last_super_admin');
    // 被禁用的 super_admin 不计入启用成员
    updateUserStatus(db, 'admin1', 'disabled');
    assert.deepEqual(guardLastSuperAdmin(db, { excludeUserId: admin2 }), { ok: false, code: 'last_super_admin' });
  }));
