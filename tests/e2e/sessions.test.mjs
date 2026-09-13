/**
 * e2e 会话（真实 HTTP 服务）：过期 401（短 TTL 实测）、过期不续期、清理证据、多会话隔离、日志脱敏。
 * 覆盖 AC-05/07/09/10/12。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-harness.mjs';
import { openDatabase, countSessions } from '../../server/db.mjs';

const USER = { username: 'bob_2026', password: 'SecretPass@8' };

test('e2e: 短 TTL 服务实测过期 401 且期间不续期（AC-12 等效复现 24h 绝对过期）', async (t) => {
  const TTL = 400;
  const server = await startTestServer({ sessionTtlMs: TTL });
  t.after(() => server.close());
  const client = server.client();
  await client.request('/api/register', { method: 'POST', body: USER });
  const login = await client.request('/api/login', { method: 'POST', body: USER });
  const expiresAt = login.body.session.expiresAt;

  const me = await client.request('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.session.expiresAt, expiresAt, '认证活动不得改变 expiresAt（不续期）');

  await new Promise((resolve) => setTimeout(resolve, TTL + 300));
  const expired = await client.request('/api/me');
  assert.equal(expired.status, 401, 'TTL 到期后受保护接口必须 401');
});

test('e2e: 过期记录清理证据（cleanupExpiredSessions 删除过期行）', async (t) => {
  const server = await startTestServer({ sessionTtlMs: 300 });
  t.after(() => server.close());
  const client = server.client();
  await client.request('/api/register', { method: 'POST', body: USER });
  await client.request('/api/login', { method: 'POST', body: USER });

  const db = openDatabase(server.dbPath);
  assert.equal(countSessions(db), 1);
  db.close();

  await new Promise((resolve) => setTimeout(resolve, 700));
  const removed = server.app.authService.cleanupExpiredSessions();
  assert.equal(removed, 1, '清理函数必须删除过期行');
  const db2 = openDatabase(server.dbPath);
  assert.equal(countSessions(db2), 0, '过期行已被删除');
  db2.close();
});

test('e2e: 多会话隔离——注销 A 后 B 仍可用（AC-07）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const clientA = server.client();
  const clientB = server.client();
  await clientA.request('/api/register', { method: 'POST', body: USER });
  await clientA.request('/api/login', { method: 'POST', body: USER });
  await clientB.request('/api/login', { method: 'POST', body: USER });
  assert.notEqual(clientA.cookie, clientB.cookie);

  assert.equal((await clientA.request('/api/me')).status, 200);
  assert.equal((await clientB.request('/api/me')).status, 200);

  await clientA.request('/api/logout', { method: 'POST', body: {} });
  assert.equal((await clientA.request('/api/me')).status, 401);
  assert.equal((await clientB.request('/api/me')).status, 200, '会话 B 必须不受 A 注销影响');
});

test('e2e: 存储形态——密码带盐哈希、会话仅存 token 哈希（AC-09）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();
  await client.request('/api/register', { method: 'POST', body: USER });
  const login = await client.request('/api/login', { method: 'POST', body: USER });
  const token = login.setCookie.split('=')[1].split(';')[0];

  const db = openDatabase(server.dbPath);
  const userRow = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(USER.username);
  assert.match(userRow.password_hash, /^scrypt:16384:8:1:/);
  assert.ok(!userRow.password_hash.includes(USER.password), '密码列不得含明文');
  const sessionRows = db.prepare('SELECT token_hash FROM sessions').all();
  assert.equal(sessionRows.length, 1);
  assert.match(sessionRows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!String(sessionRows[0].token_hash).includes(token), '会话列不得含 token 本体');
  db.close();
});

test('e2e: 日志脱敏——完整注册/登录/注销流程后日志不含明文密码与 token 本体（AC-10）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();
  await client.request('/api/register', { method: 'POST', body: USER });
  const login = await client.request('/api/login', { method: 'POST', body: USER });
  const token = login.setCookie.split('=')[1].split(';')[0];
  await client.request('/api/me');
  await client.request('/api/logout', { method: 'POST', body: {} });

  const allLogs = server.logLines.join('\n');
  assert.ok(allLogs.length > 0, '必须有请求日志');
  assert.ok(!allLogs.includes(USER.password), '日志不得含明文密码');
  assert.ok(!allLogs.includes(token), '日志不得含 token 本体');
  assert.ok(!allLogs.includes('nexora_session='), '日志不得含 Cookie 值');
});
