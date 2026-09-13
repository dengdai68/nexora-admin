/**
 * 管理领域服务（NEXORA-RBAC-011 / 架构 §3.4/§5.2）：用户/角色/授权领域操作。
 * 职责：业务规则 P-01~P-06 编排、BEGIN IMMEDIATE 事务边界、审计写入编排（成功与被拒绝均留痕，AD-11）。
 * 不感知 HTTP；结构性输入校验在 admin-routes 完成，本层做语义校验（存在性/启用态/目录成员）。
 * 并发正确性（AD-08）：所有写操作的全部状态判定（目标存在性、保护规则、最后管理员计数）与写入、审计
 * 均在同一 BEGIN IMMEDIATE 事务内完成——IMMEDIATE 写锁使并发请求的领域临界区严格串行（AC-28）。
 * 所有写路径「先全量校验，再原子替换」——校验不过不写任何业务行（AC-19/AC-21）。
 */
import {
  countRoleBindings,
  countRoles,
  countUsers,
  deleteRole,
  findRoleById,
  findRoleByKey,
  findUserByUsername,
  insertRole,
  listEnabledRoles,
  listRolePermissionKeys,
  listRoles,
  listRolesForUsers,
  listUserRoleIds,
  listUsers,
  replaceRolePermissions,
  replaceUserRoles,
  revokeSessionsByUserId,
  sampleBoundUsernames,
  updateRole,
  updateRoleStatus,
  updateUserStatus,
  withTransaction,
} from './db.mjs';
import { assertCanGrant, guardLastSuperAdmin, isSuperAdmin } from './authz.mjs';
import { SUPER_ADMIN_ROLE_KEY } from './permissions.mjs';
import { AUDIT_ACTIONS } from './audit-service.mjs';

/** 操作结果约定：{ok:true, status, body} | {ok:false, status, code, message, fields?}。 */

/**
 * 创建管理领域服务实例。
 * @param {{db: import('node:sqlite').DatabaseSync, clock: {now:()=>number}, auditService: {record:Function}}} deps
 */
export function createAdminService({ db, clock, auditService }) {
  /** 审计辅助：写成功事件。 */
  function auditSuccess(actor, action, target, detail) {
    auditService.record({ actor, action, target, result: 'success', detail });
  }

  /** 审计辅助：写拒绝事件（reason = 稳定错误码；detail 记企图摘要，永不含凭据）。 */
  function auditDenied(actor, action, target, reason, detail = {}) {
    auditService.record({ actor, action, target, result: 'denied', reason, detail });
  }

  /** super_admin 角色行（不存在说明库未迁移到 v003，属环境错误）。 */
  function superAdminRole() {
    return findRoleByKey(db, SUPER_ADMIN_ROLE_KEY);
  }

  // ---------- 用户管理 ----------

  /**
   * 用户分页列表（含每用户角色聚合，避免 N+1）。
   * @param {{q:string, page:number, pageSize:number}} query
   */
  function listUsersPage(query) {
    const users = listUsers(db, query);
    const rolesByUser = listRolesForUsers(db, users.map((u) => u.id));
    return {
      items: users.map((u) => ({
        username: u.username,
        status: u.status,
        roles: rolesByUser.get(u.id),
        createdAt: u.createdAt,
      })),
      total: countUsers(db, query.q || undefined),
    };
  }

  /**
   * 单用户详情（列表项同构字段）。
   * @param {string} username
   */
  function getUserDetail(username) {
    const user = findUserByUsername(db, username);
    if (!user) return { ok: false, status: 404, code: 'not_found', message: '用户不存在' };
    const roles = listRolesForUsers(db, [user.id]).get(user.id);
    return {
      ok: true,
      user: { username: user.username, status: user.status, roles, createdAt: user.createdAt },
    };
  }

  /**
   * 用户启停（规则 P-05/P-06；D-02 禁用即撤销全部会话，重新启用不复活）。
   * 状态判定与写入、会话撤销、审计在同一事务内完成。
   * @param {{id:number, username:string, permissions:Set<string>, isSuperAdmin:boolean}} actor
   * @param {string} username 目标用户
   * @param {'active'|'disabled'} status
   */
  function setUserStatus(actor, username, status) {
    return withTransaction(db, () => {
      const target = findUserByUsername(db, username);
      if (!target) return { ok: false, status: 404, code: 'not_found', message: '用户不存在' };
      const auditTarget = { type: 'user', id: username, label: username };
      const targetIsSuper = isSuperAdmin(db, target.id);

      // P-05：目标持有 super_admin 绑定时，仅 super_admin 可操作其启停
      if (targetIsSuper && !actor.isSuperAdmin) {
        auditDenied(actor, AUDIT_ACTIONS.USER_STATUS, auditTarget, 'super_admin_required', {
          after: { attemptedStatus: status },
        });
        return { ok: false, status: 403, code: 'super_admin_required', message: '仅超级管理员可修改超级管理员成员的状态' };
      }
      // P-06：禁用将使最后一名启用 super_admin 失效 → 事务内计数校验（AC-28）
      if (status === 'disabled' && target.status === 'active' && targetIsSuper) {
        const guard = guardLastSuperAdmin(db, { excludeUserId: target.id });
        if (!guard.ok) {
          auditDenied(actor, AUDIT_ACTIONS.USER_STATUS, auditTarget, 'last_super_admin', {
            after: { attemptedStatus: status },
          });
          return { ok: false, status: 409, code: 'last_super_admin', message: '系统至少保留一名启用的超级管理员' };
        }
      }
      const before = target.status;
      updateUserStatus(db, username, status);
      if (status === 'disabled') {
        revokeSessionsByUserId(db, target.id, clock.now());
      }
      auditSuccess(actor, AUDIT_ACTIONS.USER_STATUS, auditTarget, { before: { status: before }, after: { status } });
      return { ok: true, status: 200, body: { user: { username, status } } };
    });
  }

  /**
   * 用户角色授权（原子替换；规则 P-02/P-04/P-06）。
   * 提交集为全量新绑定：新增角色必须存在且启用；保留已有绑定（含已禁用角色）不受限（§8.3 回显口径）；
   * 解除绑定不受限。任何未知/重复/非法输入已在路由层整体 400，本层不产生部分成功。
   * @param {{id:number, username:string, permissions:Set<string>, isSuperAdmin:boolean}} actor
   * @param {string} username
   * @param {number[]} roleIds 已结构校验（正整数、无重复、长度上限内）
   */
  function setUserRoles(actor, username, roleIds) {
    return withTransaction(db, () => {
      const target = findUserByUsername(db, username);
      if (!target) return { ok: false, status: 404, code: 'not_found', message: '用户不存在' };
      const auditTarget = { type: 'user', id: username, label: username };

      // 语义校验：id 全部存在；新增绑定（当前未持有）的角色必须为启用状态
      const currentIds = listUserRoleIds(db, target.id);
      const currentSet = new Set(currentIds);
      const roles = roleIds.map((id) => findRoleById(db, id));
      const unknownIds = roleIds.filter((id, i) => !roles[i]);
      if (unknownIds.length > 0) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_params',
          message: '参数不合法',
          fields: { roleIds: `存在未知角色 id：${unknownIds.join(', ')}` },
        };
      }
      const disabledAdds = roles.filter((role, i) => !currentSet.has(roleIds[i]) && role.status !== 'active');
      if (disabledAdds.length > 0) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_params',
          message: '参数不合法',
          fields: { roleIds: `新增绑定的角色必须为启用状态：${disabledAdds.map((r) => r.key).join(', ')}` },
        };
      }

      const added = roleIds.filter((id) => !currentSet.has(id));
      const removed = currentIds.filter((id) => !roleIds.includes(id));
      const superRole = superAdminRole();
      const touchesSuper = superRole && (added.includes(superRole.id) || removed.includes(superRole.id));

      // P-02：分配/撤销 super_admin 绑定仅 super_admin 可操作
      if (touchesSuper && !actor.isSuperAdmin) {
        auditDenied(actor, AUDIT_ACTIONS.USER_ASSIGN_ROLES, auditTarget, 'super_admin_required', {
          after: { attemptedRoleIds: [...roleIds].sort((a, b) => a - b) },
        });
        return { ok: false, status: 403, code: 'super_admin_required', message: '仅超级管理员可分配或撤销超级管理员角色' };
      }
      // P-04：新增绑定角色的有效权限并集 ⊆ 操作者有效权限（super_admin 操作者豁免，D-03）
      if (!actor.isSuperAdmin && added.length > 0) {
        const addedKeys = added.flatMap((id) => listRolePermissionKeys(db, id));
        const check = assertCanGrant(actor.permissions, addedKeys);
        if (!check.ok) {
          auditDenied(actor, AUDIT_ACTIONS.USER_ASSIGN_ROLES, auditTarget, 'grant_out_of_scope', {
            after: { attemptedAddedKeys: check.missing },
          });
          return {
            ok: false,
            status: 403,
            code: 'grant_out_of_scope',
            message: `不能授予自身不具备的权限：${check.missing.join(', ')}`,
          };
        }
      }
      // P-06：撤销 super_admin 绑定将使最后一名启用 super_admin 失效 → 事务内计数校验
      if (superRole && removed.includes(superRole.id) && target.status === 'active' && isSuperAdmin(db, target.id)) {
        const guard = guardLastSuperAdmin(db, { excludeUserId: target.id });
        if (!guard.ok) {
          auditDenied(actor, AUDIT_ACTIONS.USER_ASSIGN_ROLES, auditTarget, 'last_super_admin', {
            after: { attemptedRoleIds: [...roleIds].sort((a, b) => a - b) },
          });
          return { ok: false, status: 409, code: 'last_super_admin', message: '系统至少保留一名启用的超级管理员' };
        }
      }
      replaceUserRoles(db, target.id, roleIds, actor.id, clock.now());
      auditSuccess(actor, AUDIT_ACTIONS.USER_ASSIGN_ROLES, auditTarget, {
        before: { roleIds: currentIds },
        after: { roleIds: [...roleIds].sort((a, b) => a - b) },
      });
      const rolesAfter = listRolesForUsers(db, [target.id]).get(target.id);
      return {
        ok: true,
        status: 200,
        body: { user: { username: target.username, status: target.status, roles: rolesAfter, createdAt: target.createdAt } },
      };
    });
  }

  // ---------- 角色管理 ----------

  /** 角色分页列表（含权限数/绑定用户数）。 */
  function listRolesPage(query) {
    return { items: listRoles(db, query), total: countRoles(db, query.q || undefined) };
  }

  /**
   * 角色详情（含排序 permissionKeys 回显源与绑定计数）。
   * @param {number} id
   */
  function getRoleDetail(id) {
    const role = findRoleById(db, id);
    if (!role) return { ok: false, status: 404, code: 'not_found', message: '角色不存在' };
    return {
      ok: true,
      role: {
        ...role,
        permissionKeys: listRolePermissionKeys(db, role.id),
        boundUsers: countRoleBindings(db, role.id),
      },
    };
  }

  /**
   * 新建角色（唯一标识冲突 409 role_key_taken；新角色权限集为空）。
   * @param {object} actor
   * @param {{name:string, key:string, description:string}} payload 已结构校验
   */
  function createRole(actor, { name, key, description }) {
    return withTransaction(db, () => {
      const auditTarget = { type: 'role', id: key, label: name };
      if (findRoleByKey(db, key)) {
        auditDenied(actor, AUDIT_ACTIONS.ROLE_CREATE, auditTarget, 'role_key_taken');
        return { ok: false, status: 409, code: 'role_key_taken', message: '角色唯一标识已被占用' };
      }
      const id = insertRole(db, { key, name, description, now: clock.now() });
      auditSuccess(actor, AUDIT_ACTIONS.ROLE_CREATE, { type: 'role', id: String(id), label: name }, {
        after: { key, name, description },
      });
      const role = findRoleById(db, id);
      return { ok: true, status: 201, body: { role: { ...role, permissionKeys: [], boundUsers: 0 } } };
    });
  }

  /**
   * 编辑角色名称/唯一标识/说明（P-01：super_admin 本体任何 actor 一律 403）。
   * @param {object} actor
   * @param {number} id
   * @param {{name:string, key:string, description:string}} payload
   */
  function updateRoleInfo(actor, id, { name, key, description }) {
    return withTransaction(db, () => {
      const role = findRoleById(db, id);
      if (!role) return { ok: false, status: 404, code: 'not_found', message: '角色不存在' };
      const auditTarget = { type: 'role', id: String(id), label: role.name };
      if (role.isBuiltin) {
        auditDenied(actor, AUDIT_ACTIONS.ROLE_UPDATE, auditTarget, 'role_protected');
        return { ok: false, status: 403, code: 'role_protected', message: '内置超级管理员角色受保护，不可编辑' };
      }
      const conflict = findRoleByKey(db, key);
      if (conflict && conflict.id !== id) {
        auditDenied(actor, AUDIT_ACTIONS.ROLE_UPDATE, auditTarget, 'role_key_taken', { after: { key } });
        return { ok: false, status: 409, code: 'role_key_taken', message: '角色唯一标识已被占用' };
      }
      updateRole(db, id, { key, name, description, now: clock.now() });
      const before = {};
      const after = {};
      for (const field of ['key', 'name', 'description']) {
        const next = { key, name, description }[field];
        if (role[field] !== next) {
          before[field] = role[field];
          after[field] = next;
        }
      }
      auditSuccess(actor, AUDIT_ACTIONS.ROLE_UPDATE, auditTarget, { before, after });
      const updated = findRoleById(db, id);
      return {
        ok: true,
        status: 200,
        body: { role: { ...updated, permissionKeys: listRolePermissionKeys(db, id), boundUsers: countRoleBindings(db, id) } },
      };
    });
  }

  /**
   * 角色启停（P-01：super_admin 一律 403；启停即时影响有效权限并集，R-01）。
   * @param {object} actor
   * @param {number} id
   * @param {'active'|'disabled'} status
   */
  function setRoleStatus(actor, id, status) {
    return withTransaction(db, () => {
      const role = findRoleById(db, id);
      if (!role) return { ok: false, status: 404, code: 'not_found', message: '角色不存在' };
      const auditTarget = { type: 'role', id: String(id), label: role.name };
      if (role.isBuiltin) {
        auditDenied(actor, AUDIT_ACTIONS.ROLE_STATUS, auditTarget, 'role_protected', { after: { attemptedStatus: status } });
        return { ok: false, status: 403, code: 'role_protected', message: '内置超级管理员角色受保护，不可启停' };
      }
      updateRoleStatus(db, id, status, clock.now());
      auditSuccess(actor, AUDIT_ACTIONS.ROLE_STATUS, auditTarget, {
        before: { status: role.status },
        after: { status },
      });
      return { ok: true, status: 200, body: { role: { ...findRoleById(db, id) } } };
    });
  }

  /**
   * 删除角色（P-01；绑定中 → 409 role_in_use 含数量与示例用户名，AC-11 不静默级联；
   * 可删除时同事务显式清理 role_permissions——全库无 CASCADE）。
   * @param {object} actor
   * @param {number} id
   */
  function deleteRoleById(actor, id) {
    return withTransaction(db, () => {
      const role = findRoleById(db, id);
      if (!role) return { ok: false, status: 404, code: 'not_found', message: '角色不存在' };
      const auditTarget = { type: 'role', id: String(id), label: role.name };
      if (role.isBuiltin) {
        auditDenied(actor, AUDIT_ACTIONS.ROLE_DELETE, auditTarget, 'role_protected');
        return { ok: false, status: 403, code: 'role_protected', message: '内置超级管理员角色受保护，不可删除' };
      }
      const bindings = countRoleBindings(db, id);
      if (bindings > 0) {
        const samples = sampleBoundUsernames(db, id, 3);
        auditDenied(actor, AUDIT_ACTIONS.ROLE_DELETE, auditTarget, 'role_in_use');
        return {
          ok: false,
          status: 409,
          code: 'role_in_use',
          message: `角色仍绑定 ${bindings} 个用户（${samples.join('、')}），须先解除绑定`,
        };
      }
      replaceRolePermissions(db, id, []); // 同事务显式清理权限绑定（无 CASCADE）
      deleteRole(db, id);
      auditSuccess(actor, AUDIT_ACTIONS.ROLE_DELETE, auditTarget, { before: { key: role.key, name: role.name } });
      return { ok: true, status: 200, body: { ok: true } };
    });
  }

  /**
   * 角色权限分配（原子替换；P-01 super_admin 本体保护；P-03 新增 key ⊆ 操作者有效权限，D-03）。
   * @param {object} actor
   * @param {number} id
   * @param {string[]} permissionKeys 已结构校验（字符串、去重、目录成员、长度上限内）
   */
  function setRolePermissions(actor, id, permissionKeys) {
    return withTransaction(db, () => {
      const role = findRoleById(db, id);
      if (!role) return { ok: false, status: 404, code: 'not_found', message: '角色不存在' };
      const auditTarget = { type: 'role', id: String(id), label: role.name };
      if (role.isBuiltin) {
        auditDenied(actor, AUDIT_ACTIONS.ROLE_ASSIGN_PERMISSIONS, auditTarget, 'role_protected', {
          after: { attemptedAddedKeys: [...permissionKeys].sort() },
        });
        return { ok: false, status: 403, code: 'role_protected', message: '内置超级管理员角色受保护，不可修改权限集' };
      }
      const currentKeys = listRolePermissionKeys(db, id);
      const currentSet = new Set(currentKeys);
      const added = permissionKeys.filter((key) => !currentSet.has(key));
      if (!actor.isSuperAdmin && added.length > 0) {
        const check = assertCanGrant(actor.permissions, added);
        if (!check.ok) {
          auditDenied(actor, AUDIT_ACTIONS.ROLE_ASSIGN_PERMISSIONS, auditTarget, 'grant_out_of_scope', {
            after: { attemptedAddedKeys: check.missing },
          });
          return {
            ok: false,
            status: 403,
            code: 'grant_out_of_scope',
            message: `不能授予自身不具备的权限：${check.missing.join(', ')}`,
          };
        }
      }
      const sorted = [...permissionKeys].sort();
      replaceRolePermissions(db, id, sorted);
      auditSuccess(actor, AUDIT_ACTIONS.ROLE_ASSIGN_PERMISSIONS, auditTarget, {
        before: { permissionKeys: currentKeys },
        after: { permissionKeys: sorted },
      });
      return {
        ok: true,
        status: 200,
        body: { role: { ...findRoleById(db, id), permissionKeys: sorted, boundUsers: countRoleBindings(db, id) } },
      };
    });
  }

  /** 用户授权页可选角色列表（全部启用角色）。 */
  function listAssignableRoles() {
    return listEnabledRoles(db);
  }

  return {
    listUsersPage,
    getUserDetail,
    setUserStatus,
    setUserRoles,
    listRolesPage,
    getRoleDetail,
    createRole,
    updateRoleInfo,
    setRoleStatus,
    deleteRoleById,
    setRolePermissions,
    listAssignableRoles,
  };
}
