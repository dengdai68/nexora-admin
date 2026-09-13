import { findRoleByKey, grantPermissionsToRole, upsertPermissionMeta, withTransaction } from './db.mjs';

/**
 * 权限目录（NEXORA-RBAC-011 / AD-06）：代码常量为目录唯一权威。
 * key 采用 <module>:<action> 稳定命名（D-05）；目录只增不删，由版本化迁移与启动同步维护入库；
 * 不提供任何目录写接口，杜绝虚假 key（AC-14）。新增权限 = 追加常量 + 路由守卫声明 + 一致性测试自动覆盖。
 */

/**
 * 冻结的权限目录（架构 §3.1 十项；字段：key/module/moduleName/name/description/page/apis/sortOrder）。
 * apis 声明守卫该 key 的端点，供 AC-14 双向一致性断言。
 * @type {ReadonlyArray<object>}
 */
export const PERMISSION_CATALOG = Object.freeze([
  Object.freeze({
    key: 'user:read',
    module: 'user',
    moduleName: '用户管理',
    name: '查看用户',
    description: '用户列表/搜索/分页/详情（含角色与启用状态）',
    page: '用户管理页',
    apis: Object.freeze(['GET /api/admin/users', 'GET /api/admin/users/:username']),
    sortOrder: 1,
  }),
  Object.freeze({
    key: 'user:status',
    module: 'user',
    moduleName: '用户管理',
    name: '启用/禁用用户',
    description: '修改启用状态；禁用即撤销全部会话',
    page: '用户管理页',
    apis: Object.freeze(['POST /api/admin/users/:username/status']),
    sortOrder: 2,
  }),
  Object.freeze({
    key: 'user:assign_roles',
    module: 'user',
    moduleName: '用户管理',
    name: '用户角色授权',
    description: '分配/撤销多个角色（原子保存）',
    page: '用户管理页-授权',
    apis: Object.freeze(['PUT /api/admin/users/:username/roles', 'GET /api/admin/roles/enabled']),
    sortOrder: 3,
  }),
  Object.freeze({
    key: 'role:read',
    module: 'role',
    moduleName: '角色管理',
    name: '查看角色',
    description: '角色列表/搜索/分页/详情（含权限集回显）',
    page: '角色管理页',
    apis: Object.freeze(['GET /api/admin/roles', 'GET /api/admin/roles/:id']),
    sortOrder: 4,
  }),
  Object.freeze({
    key: 'role:create',
    module: 'role',
    moduleName: '角色管理',
    name: '新建角色',
    description: '创建自定义角色（名称/唯一标识/说明）',
    page: '角色管理页',
    apis: Object.freeze(['POST /api/admin/roles']),
    sortOrder: 5,
  }),
  Object.freeze({
    key: 'role:update',
    module: 'role',
    moduleName: '角色管理',
    name: '编辑角色',
    description: '编辑名称/唯一标识/说明与启停',
    page: '角色管理页',
    apis: Object.freeze(['PUT /api/admin/roles/:id', 'POST /api/admin/roles/:id/status']),
    sortOrder: 6,
  }),
  Object.freeze({
    key: 'role:delete',
    module: 'role',
    moduleName: '角色管理',
    name: '删除角色',
    description: '删除自定义角色；绑定中返回冲突',
    page: '角色管理页',
    apis: Object.freeze(['DELETE /api/admin/roles/:id']),
    sortOrder: 7,
  }),
  Object.freeze({
    key: 'role:assign_permissions',
    module: 'role',
    moduleName: '角色管理',
    name: '角色权限分配',
    description: '授权树原子替换角色权限集',
    page: '角色管理页-授权',
    apis: Object.freeze(['PUT /api/admin/roles/:id/permissions']),
    sortOrder: 8,
  }),
  Object.freeze({
    key: 'permission:read',
    module: 'permission',
    moduleName: '权限目录',
    name: '浏览权限目录',
    description: '只读浏览/搜索目录树',
    page: '权限目录页',
    apis: Object.freeze(['GET /api/admin/permissions']),
    sortOrder: 9,
  }),
  Object.freeze({
    key: 'audit:read',
    module: 'audit',
    moduleName: '授权审计',
    name: '查看授权审计',
    description: '按操作者/对象/动作/时间分页筛选',
    page: '授权审计页',
    apis: Object.freeze(['GET /api/admin/audit-events']),
    sortOrder: 10,
  }),
]);

/** 内置超级管理员角色 key（受保护，P-01；保留字仅内置可用）。 */
export const SUPER_ADMIN_ROLE_KEY = 'super_admin';

/**
 * 目录全部 key（按 sortOrder 升序）。
 * @returns {string[]}
 */
export function catalogKeys() {
  return PERMISSION_CATALOG.map((p) => p.key);
}

/**
 * 目录 key 集合（快速包含判断）。
 * @returns {Set<string>}
 */
export function catalogKeySet() {
  return new Set(catalogKeys());
}

/**
 * 按模块分组的目录视图（GET /api/admin/permissions 响应形状的数据源）。
 * @returns {Array<{module:string, name:string, items:Array<object>}>}
 */
export function catalogGroups() {
  const groups = [];
  const byModule = new Map();
  for (const item of PERMISSION_CATALOG) {
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
      apis: [...item.apis],
    });
  }
  return groups;
}

/**
 * 启动同步（AD-06，createApp 迁移后调用一次，幂等）：
 * 目录常量元数据 upsert（只增不删）；super_admin 缺失权限 INSERT OR IGNORE 补齐（D-04 新增权限自动覆盖）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{addedKeys: string[], grantedToSuperAdmin: string[]}} 本次产生的差异（二次执行应为空）
 */
export function syncPermissionCatalog(db) {
  return withTransaction(db, () => {
    const addedKeys = [];
    for (const item of PERMISSION_CATALOG) {
      if (upsertPermissionMeta(db, item)) addedKeys.push(item.key);
    }
    let grantedToSuperAdmin = [];
    const superAdmin = findRoleByKey(db, SUPER_ADMIN_ROLE_KEY);
    if (superAdmin) {
      grantedToSuperAdmin = grantPermissionsToRole(db, superAdmin.id, catalogKeys());
    }
    return { addedKeys, grantedToSuperAdmin };
  });
}
