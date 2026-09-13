/**
 * 数据访问层（node:sqlite）：打开/关闭数据库、PRAGMA、users/sessions/RBAC 各表小粒度访问函数。
 * 只负责 SQL 与行映射，不含领域规则（领域规则在 auth-service.mjs / admin-service.mjs / authz.mjs）。
 * 全部 SQL 参数化；搜索 LIKE 参数转义 %/_/\（AC-31）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 打开（必要时创建）SQLite 数据库并启用外键约束。
 * @param {string} dbPath 数据库文件路径，':memory:' 表示内存库
 * @returns {DatabaseSync}
 */
export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

/**
 * 关闭数据库。
 * @param {DatabaseSync} db
 */
export function closeDatabase(db) {
  db.close();
}

// ---------- users ----------

/**
 * 插入用户。
 * @param {DatabaseSync} db
 * @param {{username: string, passwordHash: string, createdAt: number}} user
 * @returns {number} 新用户 id
 */
export function insertUser(db, { username, passwordHash, createdAt }) {
  const stmt = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
  const result = stmt.run(username, passwordHash, createdAt);
  return Number(result.lastInsertRowid);
}

/**
 * 按用户名精确查找用户。
 * @param {DatabaseSync} db
 * @param {string} username
 * @returns {{id:number, username:string, passwordHash:string, status:string, createdAt:number} | null}
 */
export function findUserByUsername(db, username) {
  const row = db
    .prepare('SELECT id, username, password_hash, status, created_at FROM users WHERE username = ?')
    .get(username);
  return row ? mapUserRow(row) : null;
}

/** @param {number} id */
export function findUserById(db, id) {
  const row = db.prepare('SELECT id, username, password_hash, status, created_at FROM users WHERE id = ?').get(id);
  return row ? mapUserRow(row) : null;
}

/**
 * 更新用户启用状态（'active' | 'disabled'；取值合法性由服务层校验）。
 * @param {DatabaseSync} db
 * @param {string} username
 * @param {string} status
 * @returns {boolean} 是否命中并更新
 */
export function updateUserStatus(db, username, status) {
  const result = db.prepare('UPDATE users SET status = ? WHERE username = ?').run(status, username);
  return result.changes > 0;
}

/**
 * 分页列出用户（管理后台用；按 id 升序保证稳定分页）。
 * @param {DatabaseSync} db
 * @param {{q?: string, page: number, pageSize: number}} options
 * @returns {Array<{id:number, username:string, status:string, createdAt:number}>}
 */
export function listUsers(db, { q, page, pageSize }) {
  const { where, params } = userSearchWhere(q);
  const rows = db
    .prepare(`SELECT id, username, status, created_at FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return rows.map((row) => ({
    id: Number(row.id),
    username: row.username,
    status: row.status,
    createdAt: Number(row.created_at),
  }));
}

/**
 * 统计用户总数（管理分页用）。
 * @param {DatabaseSync} db
 * @param {string} [q]
 * @returns {number}
 */
export function countUsers(db, q) {
  const { where, params } = userSearchWhere(q);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...params);
  return Number(row.n);
}

/** 用户名搜索条件（大小写不敏感子串；LIKE 通配符转义）。 */
function userSearchWhere(q) {
  if (typeof q !== 'string' || q.length === 0) return { where: '', params: [] };
  return { where: "WHERE username LIKE ? ESCAPE '\\'", params: [likePattern(q)] };
}

/**
 * 批量查询一组用户的角色绑定（避免用户列表 N+1）。
 * @param {DatabaseSync} db
 * @param {number[]} userIds
 * @returns {Map<number, Array<{id:number, key:string, name:string, status:string}>>} userId → 角色数组（按角色 id 升序）
 */
export function listRolesForUsers(db, userIds) {
  const map = new Map(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return map;
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ur.user_id, r.id, r.key, r.name, r.status
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id IN (${placeholders}) ORDER BY r.id`,
    )
    .all(...userIds);
  for (const row of rows) {
    map.get(Number(row.user_id)).push({
      id: Number(row.id),
      key: row.key,
      name: row.name,
      status: row.status,
    });
  }
  return map;
}

function mapUserRow(row) {
  return {
    id: Number(row.id),
    username: row.username,
    passwordHash: row.password_hash,
    status: row.status,
    createdAt: Number(row.created_at),
  };
}

// ---------- sessions ----------

/**
 * 写入会话（token 仅存 SHA-256 哈希）。
 * @param {DatabaseSync} db
 * @param {{userId:number, tokenHash:string, createdAt:number, expiresAt:number}} session
 * @returns {number} 会话 id
 */
export function insertSession(db, { userId, tokenHash, createdAt, expiresAt }) {
  const stmt = db.prepare(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
  );
  const result = stmt.run(userId, tokenHash, createdAt, expiresAt);
  return Number(result.lastInsertRowid);
}

/**
 * 按 token 哈希查找会话。
 * @returns {{id:number, userId:number, tokenHash:string, createdAt:number, expiresAt:number, revokedAt:number|null} | null}
 */
export function findSessionByTokenHash(db, tokenHash) {
  const row = db
    .prepare(
      'SELECT id, user_id, token_hash, created_at, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
    )
    .get(tokenHash);
  return row ? mapSessionRow(row) : null;
}

/**
 * 幂等撤销会话：无论当前是否已撤销都返回成功；返回是否在本次调用中新撤销。
 * @returns {{revoked: boolean}} revoked=true 表示本次调用首次设置 revoked_at
 */
export function revokeSessionByTokenHash(db, tokenHash, revokedAt) {
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(revokedAt, tokenHash);
  return { revoked: result.changes > 0 };
}

/**
 * 删除已过期会话（expires_at <= nowMs）。
 * @returns {number} 删除行数
 */
export function deleteExpiredSessions(db, nowMs) {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs);
  return Number(result.changes);
}

/**
 * 统计会话行数（测试断言用）。
 * @returns {number}
 */
export function countSessions(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
  return Number(row.n);
}

function mapSessionRow(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tokenHash: row.token_hash,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  };
}

/**
 * 撤销某用户全部未撤销会话（禁用用户语义 D-02：禁用即会话失效，重新启用不复活）。
 * @param {DatabaseSync} db
 * @param {number} userId
 * @param {number} now 撤销时间（毫秒）
 * @returns {number} 本次新撤销的会话数
 */
export function revokeSessionsByUserId(db, userId, now) {
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(now, userId);
  return Number(result.changes);
}

// ---------- 事务工具 ----------

/**
 * 多步写统一事务边界（AD-08）：BEGIN IMMEDIATE 获取写锁，异常回滚后抛出。
 * node:sqlite 单连接同步执行 + IMMEDIATE 写锁使并发请求的领域临界区严格串行。
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- LIKE 工具 ----------

/** 转义 LIKE 通配符并包装为子串匹配模式（配合 ESCAPE '\\'）。 */
function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------- roles ----------

/**
 * 插入角色。
 * @param {DatabaseSync} db
 * @param {{key:string, name:string, description:string, isBuiltin?:number, now:number}} role
 * @returns {number} 新角色 id
 */
export function insertRole(db, { key, name, description, isBuiltin = 0, now }) {
  const result = db
    .prepare(
      `INSERT INTO roles (key, name, description, status, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(key, name, description, isBuiltin, now, now);
  return Number(result.lastInsertRowid);
}

/**
 * 更新角色名称/唯一标识/说明。
 * @returns {boolean} 是否命中
 */
export function updateRole(db, id, { key, name, description, now }) {
  const result = db
    .prepare('UPDATE roles SET key = ?, name = ?, description = ?, updated_at = ? WHERE id = ?')
    .run(key, name, description, now, id);
  return result.changes > 0;
}

/**
 * 更新角色启停状态。
 * @returns {boolean} 是否命中
 */
export function updateRoleStatus(db, id, status, now) {
  const result = db.prepare('UPDATE roles SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  return result.changes > 0;
}

/**
 * 删除角色行（调用方须已在同事务内清理 role_permissions 并确认无用户绑定）。
 * @returns {boolean} 是否命中
 */
export function deleteRole(db, id) {
  const result = db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * @returns {{id:number, key:string, name:string, description:string, status:string, isBuiltin:boolean, createdAt:number, updatedAt:number} | null}
 */
export function findRoleById(db, id) {
  const row = db
    .prepare('SELECT id, key, name, description, status, is_builtin, created_at, updated_at FROM roles WHERE id = ?')
    .get(id);
  return row ? mapRoleRow(row) : null;
}

/** @param {string} key */
export function findRoleByKey(db, key) {
  const row = db
    .prepare('SELECT id, key, name, description, status, is_builtin, created_at, updated_at FROM roles WHERE key = ?')
    .get(key);
  return row ? mapRoleRow(row) : null;
}

/**
 * 分页列出角色（含权限数与绑定用户数；按 id 升序稳定分页）。
 * @param {DatabaseSync} db
 * @param {{q?: string, page: number, pageSize: number}} options
 */
export function listRoles(db, { q, page, pageSize }) {
  const { where, params } = roleSearchWhere(q);
  const rows = db
    .prepare(
      `SELECT r.id, r.key, r.name, r.description, r.status, r.is_builtin, r.created_at, r.updated_at,
              (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count,
              (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
       FROM roles r ${where} ORDER BY r.id LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return rows.map((row) => ({
    ...mapRoleRow(row),
    permissionCount: Number(row.permission_count),
    userCount: Number(row.user_count),
  }));
}

/**
 * 统计角色总数（管理分页用）。
 * @param {DatabaseSync} db
 * @param {string} [q]
 * @returns {number}
 */
export function countRoles(db, q) {
  const { where, params } = roleSearchWhere(q);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM roles r ${where}`).get(...params);
  return Number(row.n);
}

/** 角色搜索条件：key/name 大小写不敏感子串。 */
function roleSearchWhere(q) {
  if (typeof q !== 'string' || q.length === 0) return { where: '', params: [] };
  const pattern = likePattern(q);
  return { where: "WHERE (r.key LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')", params: [pattern, pattern] };
}

/**
 * 全部启用状态角色（用户授权可选列表用）。
 * @returns {Array<object>}
 */
export function listEnabledRoles(db) {
  const rows = db
    .prepare('SELECT id, key, name, description, status, is_builtin, created_at, updated_at FROM roles WHERE status = ? ORDER BY id')
    .all('active');
  return rows.map(mapRoleRow);
}

/**
 * 角色当前绑定的用户数（删除冲突判定）。
 * @returns {number}
 */
export function countRoleBindings(db, roleId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?').get(roleId);
  return Number(row.n);
}

/**
 * 角色绑定用户的示例用户名（冲突提示用，按用户 id 升序取前 limit 个）。
 * @returns {string[]}
 */
export function sampleBoundUsernames(db, roleId, limit) {
  const rows = db
    .prepare(
      `SELECT u.username FROM user_roles ur JOIN users u ON u.id = ur.user_id
       WHERE ur.role_id = ? ORDER BY u.id LIMIT ?`,
    )
    .all(roleId, limit);
  return rows.map((row) => row.username);
}

function mapRoleRow(row) {
  return {
    id: Number(row.id),
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    isBuiltin: Number(row.is_builtin) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------- role_permissions / user_roles ----------

/**
 * 角色已授予的权限 key（按 key 排序，回显与审计 before 快照用）。
 * @returns {string[]}
 */
export function listRolePermissionKeys(db, roleId) {
  const rows = db
    .prepare('SELECT permission_key FROM role_permissions WHERE role_id = ? ORDER BY permission_key')
    .all(roleId);
  return rows.map((row) => row.permission_key);
}

/**
 * 原子替换角色权限集（调用方须完成全量校验并包裹事务；不作任何合法性判断）。
 * @param {DatabaseSync} db
 * @param {number} roleId
 * @param {string[]} keys 已校验且去重的目录内 key
 */
export function replaceRolePermissions(db, roleId, keys) {
  db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
  const insert = db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)');
  for (const key of keys) insert.run(roleId, key);
}

/**
 * 用户已绑定的角色 id（按 id 排序，回显与审计 before 快照用）。
 * @returns {number[]}
 */
export function listUserRoleIds(db, userId) {
  const rows = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id').all(userId);
  return rows.map((row) => Number(row.role_id));
}

/**
 * 原子替换用户角色绑定（调用方须完成全量校验并包裹事务）。
 * @param {DatabaseSync} db
 * @param {number} userId
 * @param {number[]} roleIds 已校验且去重的角色 id
 * @param {number|null} grantedBy 操作者用户 id（NULL = 系统/引导）
 * @param {number} now
 */
export function replaceUserRoles(db, userId, roleIds, grantedBy, now) {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
  const insert = db.prepare(
    'INSERT INTO user_roles (user_id, role_id, granted_by, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const roleId of roleIds) insert.run(userId, roleId, grantedBy, now);
}

/**
 * 幂等授予角色一组权限（INSERT OR IGNORE）。
 * @returns {string[]} 本次实际新授予的 key
 */
export function grantPermissionsToRole(db, roleId, keys) {
  const insert = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)');
  const granted = [];
  for (const key of keys) {
    if (insert.run(roleId, key).changes > 0) granted.push(key);
  }
  return granted;
}

// ---------- permissions ----------

/**
 * 目录元数据 upsert（key 不变，其余字段以代码目录为准；从不删除 DB 已有 key，AD-06）。
 * @param {DatabaseSync} db
 * @param {{key:string, module:string, moduleName:string, name:string, description:string, page:string, apis:string[], sortOrder:number}} item
 * @returns {boolean} 是否为新插入的 key
 */
export function upsertPermissionMeta(db, item) {
  const existing = db.prepare('SELECT key FROM permissions WHERE key = ?').get(item.key);
  db.prepare(
    `INSERT INTO permissions (key, module, module_name, name, description, page, apis, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       module = excluded.module,
       module_name = excluded.module_name,
       name = excluded.name,
       description = excluded.description,
       page = excluded.page,
       apis = excluded.apis,
       sort_order = excluded.sort_order`,
  ).run(item.key, item.module, item.moduleName, item.name, item.description, item.page, JSON.stringify(item.apis), item.sortOrder);
  return !existing;
}

/**
 * DB 中全部权限 key。
 * @returns {string[]}
 */
export function listPermissionKeys(db) {
  const rows = db.prepare('SELECT key FROM permissions ORDER BY sort_order').all();
  return rows.map((row) => row.key);
}

/**
 * 按 sort_order 列出全部权限目录行（管理端目录页数据源）。
 * @returns {Array<{key:string, module:string, moduleName:string, name:string, description:string, page:string, apis:string[], sortOrder:number}>}
 */
export function listPermissions(db) {
  const rows = db
    .prepare('SELECT key, module, module_name, name, description, page, apis, sort_order FROM permissions ORDER BY sort_order')
    .all();
  return rows.map((row) => ({
    key: row.key,
    module: row.module,
    moduleName: row.module_name,
    name: row.name,
    description: row.description,
    page: row.page,
    apis: JSON.parse(row.apis),
    sortOrder: Number(row.sort_order),
  }));
}

// ---------- 有效权限与 super_admin 计数 ----------

/**
 * 用户有效权限 = 其所有已启用角色的权限并集（架构 §3.2，每请求实时解析，无缓存）。
 * @param {DatabaseSync} db
 * @param {number} userId
 * @returns {string[]} 去重后的 key 数组
 */
export function resolveEffectivePermissionKeys(db, userId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT rp.permission_key
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id AND r.status = 'active'
       JOIN role_permissions rp ON rp.role_id = r.id
       WHERE ur.user_id = ?`,
    )
    .all(userId);
  return rows.map((row) => row.permission_key);
}

/**
 * 启用 super_admin 成员数（去重）：users.status='active' 且绑定 status='active' 的 super_admin 角色。
 * P-06 最后一名保护在调用方事务内使用本计数。
 * @param {DatabaseSync} db
 * @param {string} superAdminRoleKey
 * @param {{excludeUserId?: number}} [options] 排除某用户后的计数（模拟移除该成员）
 * @returns {number}
 */
export function countEnabledSuperAdmins(db, superAdminRoleKey, { excludeUserId } = {}) {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT ur.user_id) AS n
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id AND u.status = 'active'
       JOIN roles r ON r.id = ur.role_id AND r.status = 'active'
       WHERE r.key = ? AND (? IS NULL OR ur.user_id <> ?)`,
    )
    .get(superAdminRoleKey, excludeUserId ?? null, excludeUserId ?? null);
  return Number(row.n);
}

// ---------- audit_events ----------

/**
 * 写入单行审计事件（字段由 audit-service 组装；detail 为已序列化 JSON 字符串）。
 * @param {DatabaseSync} db
 * @param {{actorUserId:number|null, actorUsername:string, action:string, targetType:string, targetId:string, targetLabel:string, result:string, reason:string|null, detail:string, createdAt:number}} event
 * @returns {number} 事件 id
 */
export function insertAuditEvent(db, event) {
  const result = db
    .prepare(
      `INSERT INTO audit_events
         (actor_user_id, actor_username, action, target_type, target_id, target_label, result, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.actorUserId,
      event.actorUsername,
      event.action,
      event.targetType,
      event.targetId,
      event.targetLabel,
      event.result,
      event.reason,
      event.detail,
      event.createdAt,
    );
  return Number(result.lastInsertRowid);
}

/** 审计筛选条件组装（actor/target 子串、action 精确、created_at 闭区间）。 */
function auditWhere({ actor, target, action, from, to }) {
  const clauses = [];
  const params = [];
  if (actor) {
    clauses.push("actor_username LIKE ? ESCAPE '\\'");
    params.push(likePattern(actor));
  }
  if (target) {
    clauses.push("(target_id LIKE ? ESCAPE '\\' OR target_label LIKE ? ESCAPE '\\')");
    params.push(likePattern(target), likePattern(target));
  }
  if (action) {
    clauses.push('action = ?');
    params.push(action);
  }
  if (from !== undefined) {
    clauses.push('created_at >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    clauses.push('created_at <= ?');
    params.push(to);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * 分页筛选审计事件（按 id 倒序，最新在前）。
 * @param {DatabaseSync} db
 * @param {{actor?:string, target?:string, action?:string, from?:number, to?:number, page:number, pageSize:number}} filters
 */
export function queryAuditEvents(db, filters) {
  const { where, params } = auditWhere(filters);
  const rows = db
    .prepare(
      `SELECT id, actor_user_id, actor_username, action, target_type, target_id, target_label, result, reason, detail, created_at
       FROM audit_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.pageSize, (filters.page - 1) * filters.pageSize);
  return rows.map(mapAuditRow);
}

/**
 * 统计审计事件总数（分页用）。
 * @param {DatabaseSync} db
 * @param {object} filters 同 queryAuditEvents（忽略分页字段）
 * @returns {number}
 */
export function countAuditEvents(db, filters) {
  const { where, params } = auditWhere(filters);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_events ${where}`).get(...params);
  return Number(row.n);
}

function mapAuditRow(row) {
  return {
    id: Number(row.id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : Number(row.actor_user_id),
    actorUsername: row.actor_username,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.target_label,
    result: row.result,
    reason: row.reason ?? null,
    detail: row.detail,
    createdAt: Number(row.created_at),
  };
}
