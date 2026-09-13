/**
 * 管理 e2e 共享辅助（NEXORA-RBAC-011）：
 * 虚构用户注册/登录、引导授权（直接调用 bootstrap 核心函数作用于线束临时库）、
 * 带 CSRF 头的写请求封装。所有数据仅存在于 server-harness 的隔离临时 SQLite（NFR-05）。
 */
import { bootstrapAdmin } from '../../server/bootstrap-admin.mjs';

/**
 * 注册虚构用户并引导为 super_admin（作用于该测试服务的临时库）。
 * @param {object} server startTestServer 返回的线束
 * @param {string} username
 * @param {string} password
 */
export async function registerAndBootstrap(server, username, password) {
  const client = server.client();
  const registered = await client.request('/api/register', { method: 'POST', body: { username, password } });
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status}`);
  const result = bootstrapAdmin(server.app.db, server.app.auditService, username, Date.now());
  if (result.status !== 'granted') throw new Error(`引导失败：${result.status}`);
}

/**
 * 登录并把会话 Cookie 装入 client jar。
 * @returns {Promise<object>} 登录响应
 */
export async function login(client, username, password) {
  const res = await client.request('/api/login', { method: 'POST', body: { username, password } });
  if (res.status !== 200) throw new Error(`登录失败：${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/** 带 CSRF 防护头的写请求（AD-03）。 */
export function writeCall(client, path, { method = 'POST', body } = {}) {
  return client.request(path, { method, body, headers: { 'X-Nexora-CSRF': '1' } });
}

/** 注册 + 登录一个普通虚构用户，返回带会话的 client。 */
export async function registerAndLogin(server, username, password) {
  const client = server.client();
  await client.request('/api/register', { method: 'POST', body: { username, password } });
  await login(client, username, password);
  return client;
}

/** 注册 + 引导 + 登录一个 super_admin 虚构用户，返回带会话的 client。 */
export async function registerBootstrapLogin(server, username, password) {
  await registerAndBootstrap(server, username, password);
  const client = server.client();
  await login(client, username, password);
  return client;
}
