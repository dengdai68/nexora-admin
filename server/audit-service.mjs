/**
 * 审计服务（NEXORA-RBAC-011 / 架构 §7，AD-11）：
 * 记录口径 = 写操作集合 {用户启停、用户授权、角色新建/编辑/启停/删除、角色权限分配、引导授权} 的成功与被拒绝事件；
 * detail 仅含角色/权限/状态差异，永不出现密码、token、Cookie 或任何凭据（AC-32）。
 */
import { countAuditEvents, insertAuditEvent, queryAuditEvents } from './db.mjs';

/** 稳定动作码（架构 §7.2）。 */
export const AUDIT_ACTIONS = Object.freeze({
  USER_STATUS: 'user.status',
  USER_ASSIGN_ROLES: 'user.assign_roles',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_STATUS: 'role.status',
  ROLE_DELETE: 'role.delete',
  ROLE_ASSIGN_PERMISSIONS: 'role.assign_permissions',
  ADMIN_BOOTSTRAP: 'admin.bootstrap',
});

/** detail 允许的顶层键白名单（防御性脱敏：出现任何其他键一律拒绝写入）。 */
const DETAIL_ALLOWED_KEYS = new Set(['before', 'after']);

/** detail before/after 值的允许键（角色/权限/状态差异专用，杜绝凭据类字段混入）。 */
const DETAIL_VALUE_KEYS = new Set([
  'status',
  'roleIds',
  'permissionKeys',
  'key',
  'name',
  'description',
  'role',
  'attemptedAddedKeys',
  'attemptedRoleIds',
  'attemptedStatus',
]);

/**
 * 防御性校验 detail 结构：仅允许 {before?, after?} 两层白名单键；非法一律抛错（调用方 bug，不落库）。
 * @param {object} detail
 */
function assertDetailSafe(detail) {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new Error('审计 detail 必须为对象');
  }
  for (const [section, value] of Object.entries(detail)) {
    if (!DETAIL_ALLOWED_KEYS.has(section)) {
      throw new Error(`审计 detail 含非白名单键：${section}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`审计 detail.${section} 必须为对象`);
    }
    for (const key of Object.keys(value)) {
      if (!DETAIL_VALUE_KEYS.has(key)) {
        throw new Error(`审计 detail.${section} 含非白名单键：${key}`);
      }
    }
  }
}

/**
 * 创建审计服务实例。
 * @param {{db: import('node:sqlite').DatabaseSync, clock: {now: () => number}}} deps
 */
export function createAuditService({ db, clock }) {
  /**
   * 写入一条审计事件。
   * @param {{
   *   actor: {id: number|null, username: string},
   *   action: string,
   *   target: {type: string, id?: string, label?: string},
   *   result: 'success' | 'denied',
   *   reason?: string|null,
   *   detail?: object,
   * }} event
   * @returns {number} 事件 id
   */
  function record({ actor, action, target, result, reason = null, detail = {} }) {
    assertDetailSafe(detail);
    return insertAuditEvent(db, {
      actorUserId: actor.id ?? null,
      actorUsername: actor.username,
      action,
      targetType: target.type,
      targetId: target.id ?? '',
      targetLabel: target.label ?? '',
      result,
      reason,
      detail: JSON.stringify(detail),
      createdAt: clock.now(),
    });
  }

  /**
   * 分页筛选查询（架构 §7.3）；detail 反序列化为对象供前端只读渲染。
   * @param {{actor?:string, target?:string, action?:string, from?:number, to?:number, page:number, pageSize:number}} filters
   * @returns {{items: Array<object>, total: number}}
   */
  function query(filters) {
    const items = queryAuditEvents(db, filters).map((row) => {
      let detail;
      try {
        detail = JSON.parse(row.detail);
      } catch {
        detail = {};
      }
      return { ...row, detail };
    });
    return { items, total: countAuditEvents(db, filters) };
  }

  return { record, query };
}
