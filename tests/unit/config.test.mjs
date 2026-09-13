import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_DEFAULTS, loadConfig } from '../../server/config.mjs';

test('config: 空环境使用默认值', () => {
  const config = loadConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4322);
  assert.equal(config.dbPath, 'data/nexora.db');
  assert.equal(config.sessionTtlMs, 86_400_000);
  assert.equal(config.commitSha, null);
});

test('config: 合法覆盖生效', () => {
  const config = loadConfig({
    NEXORA_HOST: '0.0.0.0',
    NEXORA_PORT: '5000',
    NEXORA_DB_PATH: '/tmp/x.db',
    NEXORA_SESSION_TTL_MS: '1000',
    APP_COMMIT_SHA: 'abc123',
  });
  assert.equal(config.port, 5000);
  assert.equal(config.sessionTtlMs, 1000);
  assert.equal(config.commitSha, 'abc123');
});

test('config: 非法端口快速失败且错误可读', () => {
  assert.throws(() => loadConfig({ NEXORA_PORT: 'abc' }), /NEXORA_PORT 必须为正整数/);
  assert.throws(() => loadConfig({ NEXORA_PORT: '0' }), /NEXORA_PORT 必须在 1–65535 之间/);
  assert.throws(() => loadConfig({ NEXORA_PORT: '70000' }), /NEXORA_PORT 必须在 1–65535 之间/);
});

test('config: 非法 TTL 快速失败', () => {
  assert.throws(() => loadConfig({ NEXORA_SESSION_TTL_MS: '-5' }), /NEXORA_SESSION_TTL_MS 必须为正整数/);
});

test('config: 默认值常量与文档一致', () => {
  assert.equal(CONFIG_DEFAULTS.sessionTtlMs, 86_400_000);
});
