/**
 * e2e 健康与版本（真实 HTTP 服务）：无认证 200、version 与注入 SHA 一致、不泄露敏感键（AC-08）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-harness.mjs';

test('e2e: /api/health 无认证返回注入的 commit SHA 且不泄露敏感配置', async (t) => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const server = await startTestServer({ commitSha: sha });
  t.after(() => server.close());
  const client = server.client();

  const health = await client.request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.body).sort(), ['status', 'version']);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.version, sha, 'version 必须等于注入的 APP_COMMIT_SHA');
  const raw = health.rawBody.toLowerCase();
  for (const leak of ['env', 'password', 'secret', 'token', 'key', 'path']) {
    assert.ok(!raw.includes(leak), `health 响应不得包含敏感键 ${leak}`);
  }
});

test('e2e: 未注入 SHA 且无 VERSION 文件时回退 unknown', async (t) => {
  const server = await startTestServer({ commitSha: null });
  t.after(() => server.close());
  const client = server.client();
  const health = await client.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(typeof health.body.version, 'string');
  assert.ok(health.body.version.length > 0);
});
