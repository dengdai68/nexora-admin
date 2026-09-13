/**
 * 鉴权领域层（NEXORA-RBAC-011 / 架构 §3.2/§3.4，纯领域不感知 HTTP）：
 * 有效权限并集解析、super_admin 判定、授权子集约束（P-03/P-04）、最后一名启用 super_admin 保护（P-06）。
 * 每请求实时解析（无缓存，AD-07）：角色启停/授权变更下一请求即生效（R-01/R-10）。
 */
import { countEnabledSuperAdmins, resolveEffectivePermissionKeys } from './db.mjs';
import { SUPER_ADMIN_ROLE_KEY } from './permissions.mjs';

/**
 * 用户有效权限集合：已启用角色权限并集（R-01；目录外 key 永不出现，R-02 默认拒绝）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @returns {Set<string>}
 */
export function resolveEffectivePermissions(db, userId) {
  return new Set(resolveEffectivePermissionKeys(db, userId));
}

/**
 * 用户是否持有启用状态的 super_admin 绑定（R-04）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @returns {boolean}
 */
export function isSuperAdmin(db, userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id AND r.status = 'active'
       WHERE ur.user_id = ? AND r.key = ?`,
    )
    .get(userId, SUPER_ADMIN_ROLE_KEY);
  return Number(row.n) > 0;
}

/**
 * 授权子集校验（P-03/P-04 共用，D-03）：addedKeys 必须全部在操作者有效权限内。
 * @param {Set<string>} actorPermissions 操作者有效权限
 * @param {Iterable<string>} addedKeys 拟新增的权限 key
 * @returns {{ok:true} | {ok:false, missing:string[]}} missing 为越权 key 清单（排序）
 */
export function assertCanGrant(actorPermissions, addedKeys) {
  const missing = [...new Set([...addedKeys].filter((key) => !actorPermissions.has(key)))].sort();
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * 最后一名启用 super_admin 保护（P-06，R-06）：若排除该用户后启用 super_admin 计数为 0 则拒绝。
 * 必须在调用方的 BEGIN IMMEDIATE 事务内执行，计数与写入同事务保证并发安全（AC-28）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{excludeUserId: number}} options 模拟移除该成员后的计数
 * @returns {{ok:true} | {ok:false, code:'last_super_admin'}}
 */
export function guardLastSuperAdmin(db, { excludeUserId }) {
  const remaining = countEnabledSuperAdmins(db, SUPER_ADMIN_ROLE_KEY, { excludeUserId });
  return remaining > 0 ? { ok: true } : { ok: false, code: 'last_super_admin' };
}
