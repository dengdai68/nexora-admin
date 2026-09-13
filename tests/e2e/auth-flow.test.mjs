/**
 * e2e 主链路（真实 HTTP 服务）：注册 → 登录 → me/resource → 注销；
 * 重名 409；通用 401 逐字节一致；Cookie 属性断言；注册不建会话（AC-01/02/03/05/06/13）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-harness.mjs';

const USER = { username: 'alice_01', password: 'Password@123' };

test('e2e: 注册 201 不建会话不下发 Cookie；重名 409', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();

  const created = await client.request('/api/register', { method: 'POST', body: USER });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { user: { username: USER.username } });
  assert.equal(created.setCookie, null, '注册成功不得下发会话 Cookie（Q2）');
  assert.equal(client.cookie, null);

  const me = await client.request('/api/me');
  assert.equal(me.status, 401, '注册后不带会话访问受保护接口必须 401');

  const dup = await client.request('/api/register', { method: 'POST', body: USER });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'username_taken');
});

test('e2e: 登录 200 + Set-Cookie 属性齐全（HttpOnly/SameSite=Lax/Path/Max-Age，无 Secure）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();
  await client.request('/api/register', { method: 'POST', body: USER });

  const login = await client.request('/api/login', { method: 'POST', body: USER });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.username, USER.username);
  assert.equal(typeof login.body.session.expiresAt, 'number');
  assert.ok(login.setCookie, '登录必须下发 Set-Cookie');
  assert.match(login.setCookie, /^nexora_session=[A-Za-z0-9_-]+/);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Lax/);
  assert.match(login.setCookie, /Path=\//);
  assert.match(login.setCookie, /Max-Age=86400/);
  assert.ok(!/Secure/.test(login.setCookie), 'loopback 开发模式不设 Secure（Q5）');
  assert.ok(!JSON.stringify(login.body).includes(login.setCookie.split('=')[1].split(';')[0]), 'token 本体不得出现在响应体');
});

test('e2e: 通用 401——不存在用户与错误口令响应体逐字节一致', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();
  await client.request('/api/register', { method: 'POST', body: USER });

  const noUser = await client.request('/api/login', {
    method: 'POST',
    body: { username: 'ghost_99', password: 'Password@123' },
  });
  const wrongPass = await client.request('/api/login', {
    method: 'POST',
    body: { username: USER.username, password: 'WrongPass@99' },
  });
  assert.equal(noUser.status, 401);
  assert.equal(wrongPass.status, 401);
  assert.equal(noUser.rawBody, wrongPass.rawBody, 'AC-02：两种失败响应体必须逐字节一致');
  assert.equal(noUser.body.error.code, 'invalid_credentials');
});

test('e2e: 主链路——me/resource 受保护，注销后失效且 Cookie 清除，幂等三连', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();
  await client.request('/api/register', { method: 'POST', body: USER });
  await client.request('/api/login', { method: 'POST', body: USER });

  const me = await client.request('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, USER.username);

  const resource = await client.request('/api/resource');
  assert.equal(resource.status, 200);
  assert.deepEqual(resource.body.resource, { title: '云枢后台示例资源', owner: USER.username });

  // 第一次注销
  const logout1 = await client.request('/api/logout', { method: 'POST', body: {} });
  assert.equal(logout1.status, 200);
  assert.deepEqual(logout1.body, { ok: true });
  assert.match(logout1.setCookie, /Max-Age=0/, '注销必须清除客户端 Cookie');
  assert.equal(client.cookie, null);

  const meAfter = await client.request('/api/me');
  assert.equal(meAfter.status, 401, '注销后原会话立即失效');

  // 幂等：重复注销与无会话注销返回相同成功语义
  const logout2 = await client.request('/api/logout', { method: 'POST', body: {} });
  const logout3 = await server.client().request('/api/logout', { method: 'POST', body: {} });
  assert.equal(logout2.status, 200);
  assert.equal(logout3.status, 200);
  assert.deepEqual(logout2.body, { ok: true });
  assert.deepEqual(logout3.body, { ok: true });
  assert.match(logout3.setCookie, /Max-Age=0/);
});

test('e2e: 伪造 token 访问受保护接口 401', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();
  client.setCookie('nexora_session=forged-token-value');
  const me = await client.request('/api/me');
  assert.equal(me.status, 401);
  assert.equal(me.body.error.code, 'unauthorized');
});
