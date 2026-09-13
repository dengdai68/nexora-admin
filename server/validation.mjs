/**
 * 输入校验（纯函数）：
 * 注册与登录共用同一套边界——username：必填，3–32 字符，仅 [A-Za-z0-9_-]；password：必填，8–128 字符。
 * 管理接口（NEXORA-RBAC-011）：角色载荷、启停载荷、roleIds/permissionKeys 载荷、分页/搜索/审计筛选参数。
 * 返回 { ok, fields }；fields 仅含校验结论，不泄露内部细节。
 */

const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/**
 * 校验注册/登录请求体结构。
 * @param {unknown} body 已解析的 JSON
 * @returns {{ok: true, value: {username: string, password: string}} | {ok: false, fields: Record<string, string>}}
 */
export function validateCredentials(body) {
  const fields = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, fields: { body: '请求体必须为 JSON 对象' } };
  }
  const usernameError = validateUsername(body.username);
  if (usernameError) fields.username = usernameError;
  const passwordError = validatePassword(body.password);
  if (passwordError) fields.password = passwordError;
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { username: body.username, password: body.password } };
}

/** @returns {string|null} 错误信息或 null */
export function validateUsername(username) {
  if (typeof username !== 'string' || username.length === 0) return '用户名为必填项';
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return `用户名长度须为 ${USERNAME_MIN}–${USERNAME_MAX} 字符`;
  }
  if (!USERNAME_PATTERN.test(username)) return '用户名仅允许字母、数字、下划线与连字符';
  return null;
}

/** @returns {string|null} 错误信息或 null */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) return '密码为必填项';
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `密码长度须为 ${PASSWORD_MIN}–${PASSWORD_MAX} 字符`;
  }
  return null;
}

export const LIMITS = Object.freeze({
  usernameMin: USERNAME_MIN,
  usernameMax: USERNAME_MAX,
  passwordMin: PASSWORD_MIN,
  passwordMax: PASSWORD_MAX,
});

// ---------- 管理接口输入校验（NEXORA-RBAC-011；纯函数，admin-routes 使用） ----------

const ROLE_NAME_MAX = 50;
const ROLE_KEY_MIN = 2;
const ROLE_KEY_MAX = 50;
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const ROLE_DESCRIPTION_MAX = 200;
const ROLE_KEY_RESERVED = new Set(['super_admin']); // 保留字仅内置角色可用（P-01）
const SEARCH_Q_MAX = 64;
const PAGE_SIZE_MAX = 50;

/**
 * 校验角色名称/唯一标识/说明载荷（新建与编辑共用）。
 * @param {unknown} body
 * @returns {{ok:true, value:{name:string, key:string, description:string}} | {ok:false, fields:Record<string,string>}}
 */
export function validateRolePayload(body) {
  const fields = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, fields: { body: '请求体必须为 JSON 对象' } };
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (typeof body.name !== 'string' || name.length === 0) fields.name = '角色名称为必填项';
  else if (name.length > ROLE_NAME_MAX) fields.name = `角色名称长度须为 1–${ROLE_NAME_MAX} 字符`;
  if (typeof body.key !== 'string' || body.key.length === 0) fields.key = '角色唯一标识为必填项';
  else if (body.key.length < ROLE_KEY_MIN || body.key.length > ROLE_KEY_MAX) {
    fields.key = `角色唯一标识长度须为 ${ROLE_KEY_MIN}–${ROLE_KEY_MAX} 字符`;
  } else if (!ROLE_KEY_PATTERN.test(body.key)) fields.key = '角色唯一标识仅允许小写字母开头的字母/数字/下划线';
  else if (ROLE_KEY_RESERVED.has(body.key)) fields.key = '该标识为内置保留字，不可使用';
  const description = body.description === undefined ? '' : body.description;
  if (typeof description !== 'string') fields.description = '角色说明必须为字符串';
  else if (description.length > ROLE_DESCRIPTION_MAX) fields.description = `角色说明长度须不超过 ${ROLE_DESCRIPTION_MAX} 字符`;
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { name, key: body.key, description } };
}

/**
 * 校验启停载荷：{status:'active'|'disabled'}。
 * @param {unknown} body
 * @returns {{ok:true, value:{status:string}} | {ok:false, fields:Record<string,string>}}
 */
export function validateStatusPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, fields: { body: '请求体必须为 JSON 对象' } };
  }
  if (body.status !== 'active' && body.status !== 'disabled') {
    return { ok: false, fields: { status: "状态仅允许 'active' 或 'disabled'" } };
  }
  return { ok: true, value: { status: body.status } };
}

/**
 * 校验用户授权载荷：{roleIds:[整数...]}——类型、正整数、无重复、长度上限逐一校验（整体 400，无部分成功）。
 * @param {unknown} body
 * @param {{maxCount:number}} limits 长度上限（角色总数）
 * @returns {{ok:true, value:{roleIds:number[]}} | {ok:false, fields:Record<string,string>}}
 */
export function validateRoleIdsPayload(body, { maxCount }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, fields: { body: '请求体必须为 JSON 对象' } };
  }
  const roleIds = body.roleIds;
  if (!Array.isArray(roleIds)) return { ok: false, fields: { roleIds: 'roleIds 必须为数组' } };
  if (roleIds.length > maxCount) return { ok: false, fields: { roleIds: `roleIds 长度不得超过 ${maxCount}` } };
  const invalid = roleIds.filter((id) => !Number.isSafeInteger(id) || id < 1);
  if (invalid.length > 0) return { ok: false, fields: { roleIds: 'roleIds 元素必须为正整数' } };
  if (new Set(roleIds).size !== roleIds.length) return { ok: false, fields: { roleIds: 'roleIds 存在重复项' } };
  return { ok: true, value: { roleIds } };
}

/**
 * 校验角色授权载荷：{permissionKeys:[key...]}——类型、字符串、去重、长度上限、目录成员逐一校验；
 * 未知 key 在 fields.permissionKeys 中列清单（AC-19）。
 * @param {unknown} body
 * @param {{catalogKeys:Set<string>}} catalog
 * @returns {{ok:true, value:{permissionKeys:string[]}} | {ok:false, fields:Record<string,string>}}
 */
export function validatePermissionKeysPayload(body, { catalogKeys: knownKeys }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, fields: { body: '请求体必须为 JSON 对象' } };
  }
  const keys = body.permissionKeys;
  if (!Array.isArray(keys)) return { ok: false, fields: { permissionKeys: 'permissionKeys 必须为数组' } };
  if (keys.length > knownKeys.size) {
    return { ok: false, fields: { permissionKeys: `permissionKeys 长度不得超过 ${knownKeys.size}` } };
  }
  if (keys.some((key) => typeof key !== 'string')) {
    return { ok: false, fields: { permissionKeys: 'permissionKeys 元素必须为字符串' } };
  }
  if (new Set(keys).size !== keys.length) {
    return { ok: false, fields: { permissionKeys: 'permissionKeys 存在重复项' } };
  }
  const unknown = keys.filter((key) => !knownKeys.has(key));
  if (unknown.length > 0) {
    return { ok: false, fields: { permissionKeys: `存在目录外的权限 key：${unknown.join(', ')}` } };
  }
  return { ok: true, value: { permissionKeys: keys } };
}

/**
 * 解析分页与搜索参数：page ≥1 默认 1；pageSize 1–50 默认 20；q ≤64 字符。
 * @param {URLSearchParams} query
 * @returns {{ok:true, value:{page:number, pageSize:number, q:string}} | {ok:false, fields:Record<string,string>}}
 */
export function parseListQuery(query) {
  const fields = {};
  const rawPage = query.get('page');
  const rawPageSize = query.get('pageSize');
  const q = query.get('q') ?? '';
  let page = 1;
  let pageSize = 20;
  if (rawPage !== null && rawPage !== '') {
    if (!/^\d+$/.test(rawPage) || Number(rawPage) < 1) fields.page = 'page 须为 ≥1 的整数';
    else page = Number(rawPage);
  }
  if (rawPageSize !== null && rawPageSize !== '') {
    if (!/^\d+$/.test(rawPageSize) || Number(rawPageSize) < 1 || Number(rawPageSize) > PAGE_SIZE_MAX) {
      fields.pageSize = `pageSize 须为 1–${PAGE_SIZE_MAX} 的整数`;
    } else pageSize = Number(rawPageSize);
  }
  if (q.length > SEARCH_Q_MAX) fields.q = `q 长度须不超过 ${SEARCH_Q_MAX} 字符`;
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { page, pageSize, q } };
}

/**
 * 解析审计筛选参数：actor/target 子串（≤64）、action 精确、from/to 毫秒整数闭区间；分页同上。
 * @param {URLSearchParams} query
 * @param {Set<string>} knownActions 合法动作码集合
 * @returns {{ok:true, value:object} | {ok:false, fields:Record<string,string>}}
 */
export function parseAuditQuery(query, knownActions) {
  const fields = {};
  const base = parseListQuery(query);
  if (!base.ok) Object.assign(fields, base.fields);
  const actor = query.get('actor') ?? '';
  const target = query.get('target') ?? '';
  const action = query.get('action') ?? '';
  const rawFrom = query.get('from');
  const rawTo = query.get('to');
  let from;
  let to;
  if (actor.length > SEARCH_Q_MAX) fields.actor = `actor 长度须不超过 ${SEARCH_Q_MAX} 字符`;
  if (target.length > SEARCH_Q_MAX) fields.target = `target 长度须不超过 ${SEARCH_Q_MAX} 字符`;
  if (action && !knownActions.has(action)) fields.action = '未知动作码';
  if (rawFrom !== null && rawFrom !== '') {
    if (!/^\d+$/.test(rawFrom)) fields.from = 'from 须为毫秒整数';
    else from = Number(rawFrom);
  }
  if (rawTo !== null && rawTo !== '') {
    if (!/^\d+$/.test(rawTo)) fields.to = 'to 须为毫秒整数';
    else to = Number(rawTo);
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  const { page, pageSize } = base.ok ? base.value : { page: 1, pageSize: 20 };
  return {
    ok: true,
    value: {
      actor: actor || undefined,
      target: target || undefined,
      action: action || undefined,
      from,
      to,
      page,
      pageSize,
    },
  };
}
