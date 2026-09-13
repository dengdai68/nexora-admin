/**
 * 输入校验（纯函数，注册与登录共用同一套边界，AC-14）：
 * username：必填，3–32 字符，仅 [A-Za-z0-9_-]
 * password：必填，8–128 字符
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
