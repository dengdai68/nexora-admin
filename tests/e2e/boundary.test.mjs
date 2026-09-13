/**
 * e2e 边界（真实 HTTP 服务）：参数边界 400 字段级、413/415/404/405、静态资源与路径穿越防护。
 * 覆盖 AC-14 与架构 §3 通用约定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-harness.mjs';

test('e2e: 注册/登录参数边界 400 且带字段级错误（AC-14）', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();

  const cases = [
    { body: { username: '', password: 'Password@123' }, field: 'username' },
    { body: { username: 'ab', password: 'Password@123' }, field: 'username' },
    { body: { username: 'a'.repeat(33), password: 'Password@123' }, field: 'username' },
    { body: { username: '含中文', password: 'Password@123' }, field: 'username' },
    { body: { username: 'alice', password: '' }, field: 'password' },
    { body: { username: 'alice', password: '1234567' }, field: 'password' },
    { body: { username: 'alice', password: 'x'.repeat(129) }, field: 'password' },
  ];
  for (const { body, field } of cases) {
    for (const path of ['/api/register', '/api/login']) {
      const res = await client.request(path, { method: 'POST', body });
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal(res.body.error.code, 'invalid_params');
      assert.ok(res.body.error.fields[field], `字段级错误必须包含 ${field}`);
      assert.ok(!res.rawBody.includes('scrypt'), '边界错误响应不得泄露内部细节');
    }
  }
});

test('e2e: 非 JSON Content-Type → 415；JSON 解析失败 → 400', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();

  const form = await client.request('/api/login', {
    method: 'POST',
    body: 'username=a&password=b',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.status, 415);

  const badJson = await client.request('/api/login', { method: 'POST', body: '{not-json' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'invalid_json');
});

test('e2e: 请求体超 16KB → 413', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();
  const big = JSON.stringify({ username: 'alice', password: 'p'.repeat(17 * 1024) });
  const res = await client.request('/api/login', { method: 'POST', body: big });
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'payload_too_large');
});

test('e2e: 未知 API 路径 → 404；方法不允许 → 405', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();

  const notFound = await client.request('/api/nope');
  assert.equal(notFound.status, 404);

  const wrongMethod = await client.request('/api/login', { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get('allow') || '', /POST/);
});

test('e2e: 静态资源白名单——/ 返回页面；路径穿越 → 404', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const client = server.client();

  const index = await client.request('/');
  assert.equal(index.status, 200);
  assert.ok(index.rawBody.includes('云枢后台'));

  for (const asset of ['/styles.css', '/app.js']) {
    const res = await client.request(asset);
    assert.equal(res.status, 200, asset);
  }

  const traversal = await client.request('/../server/db.mjs');
  assert.equal(traversal.status, 404, '路径穿越必须被白名单拦截');
  const direct = await client.request('/server/db.mjs');
  assert.equal(direct.status, 404);
});
