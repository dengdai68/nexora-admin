/**
 * 管理 API 路由（NEXORA-RBAC-011 / 架构 §3.3/§4.2）：
 * 每个处理器经固定守卫链包装——requireSession(401) → requireCsrf(写方法 403 csrf_protection)
 * → requirePermission(403 forbidden，写操作拒绝同时落审计，AD-11) → 业务处理器（P 规则在 admin-service）。
 * 不信任请求体任何身份/角色/权限字段：路径参数为唯一对象寻址来源，ctx.session.user 为唯一操作者来源（AC-25）。
 */
import { errorBody } from './http-server.mjs';
import { SESSION_COOKIE } from './routes.mjs';
import { resolveEffectivePermissions, isSuperAdmin } from './authz.mjs';
import { catalogKeySet } from './permissions.mjs';
import { countRoles, findRoleById, listPermissions } from './db.mjs';
import { AUDIT_ACTIONS } from './audit-service.mjs';
import {
  parseAuditQuery,
  parseListQuery,
  validatePermissionKeysPayload,
  validateRoleIdsPayload,
  validateRolePayload,
  validateStatusPayload,
} from './validation.mjs';

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const CSRF_HEADER = 'x-nexora-csrf';

/**
 * 受保护管理路由元数据（权限 key ⇄ 端点映射，AC-14 一致性断言的数据源）。
 * 与 buildAdminRoutes 注册的路由一一对应；任何改动必须同步并通过 rbac-consistency 单测。
 */
export const ADMIN_ROUTES_META = Object.freeze([
  Object.freeze({ method: 'GET', path: '/api/admin/users', permission: 'user:read' }),
  Object.freeze({ method: 'GET', path: '/api/admin/users/:username', permission: 'user:read' }),
  Object.freeze({ method: 'POST', path: '/api/admin/users/:username/status', permission: 'user:status', auditAction: AUDIT_ACTIONS.USER_STATUS, auditTargetType: 'user', auditTargetParam: 'username' }),
  Object.freeze({ method: 'PUT', path: '/api/admin/users/:username/roles', permission: 'user:assign_roles', auditAction: AUDIT_ACTIONS.USER_ASSIGN_ROLES, auditTargetType: 'user', auditTargetParam: 'username' }),
  Object.freeze({ method: 'GET', path: '/api/admin/roles', permission: 'role:read' }),
  Object.freeze({ method: 'GET', path: '/api/admin/roles/enabled', permission: 'user:assign_roles' }),
  Object.freeze({ method: 'GET', path: '/api/admin/roles/:id', permission: 'role:read' }),
  Object.freeze({ method: 'POST', path: '/api/admin/roles', permission: 'role:create', auditAction: AUDIT_ACTIONS.ROLE_CREATE, auditTargetType: 'role' }),
  Object.freeze({ method: 'PUT', path: '/api/admin/roles/:id', permission: 'role:update', auditAction: AUDIT_ACTIONS.ROLE_UPDATE, auditTargetType: 'role', auditTargetParam: 'id' }),
  Object.freeze({ method: 'POST', path: '/api/admin/roles/:id/status', permission: 'role:update', auditAction: AUDIT_ACTIONS.ROLE_STATUS, auditTargetType: 'role', auditTargetParam: 'id' }),
  Object.freeze({ method: 'DELETE', path: '/api/admin/roles/:id', permission: 'role:delete', auditAction: AUDIT_ACTIONS.ROLE_DELETE, auditTargetType: 'role', auditTargetParam: 'id' }),
  Object.freeze({ method: 'PUT', path: '/api/admin/roles/:id/permissions', permission: 'role:assign_permissions', auditAction: AUDIT_ACTIONS.ROLE_ASSIGN_PERMISSIONS, auditTargetType: 'role', auditTargetParam: 'id' }),
  Object.freeze({ method: 'GET', path: '/api/admin/permissions', permission: 'permission:read' }),
  Object.freeze({ method: 'GET', path: '/api/admin/audit-events', permission: 'audit:read' }),
]);

/**
 * 构建管理 API 路由表。
 * @param {{db: object, authService: object, adminService: object, auditService: object}} deps
 */
export function buildAdminRoutes({ db, authService, adminService, auditService }) {
  /**
   * 固定守卫链（架构 §3.3）：会话 → CSRF（写） → 权限（写操作拒绝落审计）。
   * 通过后将操作者上下文放入 ctx.actor（含有效权限与 super_admin 标记，供业务规则复用，避免重复查询）。
   * @returns {null | {status:number, body:object}} null 表示放行
   */
  function guard(ctx, meta) {
    const session = authService.resolveSession(ctx.cookies[SESSION_COOKIE]);
    if (!session) {
      return { status: 401, body: errorBody('unauthorized', '未认证或会话已失效') };
    }
    ctx.session = session;
    if (WRITE_METHODS.has(ctx.method) && ctx.req.headers[CSRF_HEADER] !== '1') {
      return { status: 403, body: errorBody('csrf_protection', '写操作缺少 CSRF 防护头') };
    }
    const permissions = resolveEffectivePermissions(db, session.user.id);
    if (!permissions.has(meta.permission)) {
      // AD-11：写操作的权限拒绝落审计；只读接口 403 仅进请求日志（由 HTTP 层记录稳定 code）
      if (WRITE_METHODS.has(ctx.method) && meta.auditAction) {
        auditService.record({
          actor: { id: session.user.id, username: session.user.username },
          action: meta.auditAction,
          target: {
            type: meta.auditTargetType,
            id: meta.auditTargetParam ? String(ctx.params[meta.auditTargetParam] ?? '') : '',
          },
          result: 'denied',
          reason: 'forbidden',
        });
      }
      return { status: 403, body: errorBody('forbidden', '没有执行该操作的权限') };
    }
    ctx.actor = {
      id: session.user.id,
      username: session.user.username,
      permissions,
      isSuperAdmin: isSuperAdmin(db, session.user.id),
    };
    return null;
  }

  /** 包装：守卫链 → 业务处理器。 */
  function guarded(meta, handler) {
    return (ctx) => {
      const denied = guard(ctx, meta);
      if (denied) return denied;
      return handler(ctx);
    };
  }

  /** 领域结果 → HTTP 响应。 */
  function respond(result) {
    if (result.ok) return { status: result.status, body: result.body };
    return { status: result.status, body: errorBody(result.code, result.message, result.fields) };
  }

  /** 解析查询字符串。 */
  function queryOf(ctx) {
    return new URL(ctx.req.url || '/', 'http://localhost').searchParams;
  }

  /** 列表响应包装。 */
  function listBody(page, items, total) {
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  /** 解析角色 id 路径参数：非正整数 → null（按未知对象处理，404）。 */
  function parseRoleId(ctx) {
    const raw = ctx.params.id;
    if (!/^\d+$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
  }

  const NOT_FOUND_ROLE = { status: 404, body: errorBody('not_found', '角色不存在') };

  /**
   * 内置角色保护前置（DEF-01 / AC-12 / P-01）：
   * 路径寻址不依赖请求体，保护判定先于载荷校验——目标为内置角色时无论载荷如何，
   * 一律 403 role_protected 并按 AD-11 写 denied 审计；目标不存在 → 404；非内置 → null（放行后续校验）。
   * admin-service 事务内的同款判定保留为权威兜底（防御纵深）。
   */
  function preCheckProtectedRole(ctx, meta, roleId, message) {
    const role = findRoleById(db, roleId);
    if (!role) return NOT_FOUND_ROLE;
    if (!role.isBuiltin) return null;
    auditService.record({
      actor: { id: ctx.actor.id, username: ctx.actor.username },
      action: meta.auditAction,
      target: { type: 'role', id: String(roleId), label: role.name },
      result: 'denied',
      reason: 'role_protected',
    });
    return { status: 403, body: errorBody('role_protected', message) };
  }

  const handlers = {
    listUsers: (ctx) => {
      const parsed = parseListQuery(queryOf(ctx));
      if (!parsed.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', parsed.fields) };
      const { items, total } = adminService.listUsersPage(parsed.value);
      return { status: 200, body: listBody(parsed.value, items, total) };
    },
    getUser: (ctx) => {
      const result = adminService.getUserDetail(ctx.params.username);
      if (!result.ok) return respond(result);
      return { status: 200, body: { user: result.user } };
    },
    setUserStatus: (ctx) => {
      const checked = validateStatusPayload(ctx.body);
      if (!checked.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', checked.fields) };
      return respond(adminService.setUserStatus(ctx.actor, ctx.params.username, checked.value.status));
    },
    setUserRoles: (ctx) => {
      const checked = validateRoleIdsPayload(ctx.body, { maxCount: Math.max(countRoles(db), 1) });
      if (!checked.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', checked.fields) };
      return respond(adminService.setUserRoles(ctx.actor, ctx.params.username, checked.value.roleIds));
    },
    listRoles: (ctx) => {
      const parsed = parseListQuery(queryOf(ctx));
      if (!parsed.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', parsed.fields) };
      const { items, total } = adminService.listRolesPage(parsed.value);
      return { status: 200, body: listBody(parsed.value, items, total) };
    },
    listEnabledRoles: () => {
      // 用户授权页可选角色源：全部启用角色（不分页；授予操作本身仍须 user:assign_roles）
      const items = adminService
        .listAssignableRoles()
        .map((role) => ({ id: role.id, key: role.key, name: role.name, status: role.status }));
      return { status: 200, body: { items } };
    },
    getRole: (ctx) => {
      const id = parseRoleId(ctx);
      if (id === null) return NOT_FOUND_ROLE;
      const result = adminService.getRoleDetail(id);
      if (!result.ok) return respond(result);
      return { status: 200, body: { role: result.role } };
    },
    createRole: (ctx) => {
      const checked = validateRolePayload(ctx.body);
      if (!checked.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', checked.fields) };
      return respond(adminService.createRole(ctx.actor, checked.value));
    },
    updateRole: (ctx) => {
      const id = parseRoleId(ctx);
      if (id === null) return NOT_FOUND_ROLE;
      const meta = bySignatureMeta.get('PUT /api/admin/roles/:id');
      const protectedDeny = preCheckProtectedRole(ctx, meta, id, '内置超级管理员角色受保护，不可编辑');
      if (protectedDeny) return protectedDeny;
      const checked = validateRolePayload(ctx.body);
      if (!checked.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', checked.fields) };
      return respond(adminService.updateRoleInfo(ctx.actor, id, checked.value));
    },
    setRoleStatus: (ctx) => {
      const id = parseRoleId(ctx);
      if (id === null) return NOT_FOUND_ROLE;
      const meta = bySignatureMeta.get('POST /api/admin/roles/:id/status');
      const protectedDeny = preCheckProtectedRole(ctx, meta, id, '内置超级管理员角色受保护，不可启停');
      if (protectedDeny) return protectedDeny;
      const checked = validateStatusPayload(ctx.body);
      if (!checked.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', checked.fields) };
      return respond(adminService.setRoleStatus(ctx.actor, id, checked.value.status));
    },
    deleteRole: (ctx) => {
      const id = parseRoleId(ctx);
      if (id === null) return NOT_FOUND_ROLE;
      return respond(adminService.deleteRoleById(ctx.actor, id));
    },
    setRolePermissions: (ctx) => {
      const id = parseRoleId(ctx);
      if (id === null) return NOT_FOUND_ROLE;
      const meta = bySignatureMeta.get('PUT /api/admin/roles/:id/permissions');
      const protectedDeny = preCheckProtectedRole(ctx, meta, id, '内置超级管理员角色受保护，不可修改权限集');
      if (protectedDeny) return protectedDeny;
      const checked = validatePermissionKeysPayload(ctx.body, { catalogKeys: catalogKeySet() });
      if (!checked.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', checked.fields) };
      return respond(adminService.setRolePermissions(ctx.actor, id, checked.value.permissionKeys));
    },
    listPermissions: () => {
      // 目录只读浏览：DB 镜像按 sort_order 分组（启动同步保证与代码目录一致，AD-06）
      const groups = [];
      const byModule = new Map();
      for (const item of listPermissions(db)) {
        if (!byModule.has(item.module)) {
          const group = { module: item.module, name: item.moduleName, items: [] };
          byModule.set(item.module, group);
          groups.push(group);
        }
        byModule.get(item.module).items.push({
          key: item.key,
          name: item.name,
          description: item.description,
          page: item.page,
          apis: item.apis,
        });
      }
      return { status: 200, body: { groups } };
    },
    listAuditEvents: (ctx) => {
      const parsed = parseAuditQuery(queryOf(ctx), new Set(Object.values(AUDIT_ACTIONS)));
      if (!parsed.ok) return { status: 400, body: errorBody('invalid_params', '参数不合法', parsed.fields) };
      const { items, total } = auditService.query(parsed.value);
      return {
        status: 200,
        body: listBody(
          parsed.value,
          items.map((row) => ({
            id: row.id,
            actorUsername: row.actorUsername,
            action: row.action,
            targetType: row.targetType,
            targetId: row.targetId,
            targetLabel: row.targetLabel,
            result: row.result,
            reason: row.reason,
            detail: row.detail,
            createdAt: row.createdAt,
          })),
          total,
        ),
      };
    },
  };

  const bySignature = new Map([
    ['GET /api/admin/users', handlers.listUsers],
    ['GET /api/admin/users/:username', handlers.getUser],
    ['POST /api/admin/users/:username/status', handlers.setUserStatus],
    ['PUT /api/admin/users/:username/roles', handlers.setUserRoles],
    ['GET /api/admin/roles', handlers.listRoles],
    ['GET /api/admin/roles/enabled', handlers.listEnabledRoles],
    ['GET /api/admin/roles/:id', handlers.getRole],
    ['POST /api/admin/roles', handlers.createRole],
    ['PUT /api/admin/roles/:id', handlers.updateRole],
    ['POST /api/admin/roles/:id/status', handlers.setRoleStatus],
    ['DELETE /api/admin/roles/:id', handlers.deleteRole],
    ['PUT /api/admin/roles/:id/permissions', handlers.setRolePermissions],
    ['GET /api/admin/permissions', handlers.listPermissions],
    ['GET /api/admin/audit-events', handlers.listAuditEvents],
  ]);

  /** "METHOD path" → 路由元数据（前置保护判定取审计动作码用）。 */
  const bySignatureMeta = new Map(ADMIN_ROUTES_META.map((meta) => [`${meta.method} ${meta.path}`, meta]));

  return ADMIN_ROUTES_META.map((meta) => ({
    method: meta.method,
    path: meta.path,
    handler: guarded(meta, bySignature.get(`${meta.method} ${meta.path}`)),
  }));
}
