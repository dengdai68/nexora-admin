import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClock } from '../../server/clock.mjs';
import { openMigratedDatabase } from '../../server/migrations.mjs';
import { createAuthService, INVALID_CREDENTIALS } from '../../server/auth-service.mjs';
import { countSessions } from '../../server/db.mjs';

const DAY_MS = 86_400_000;

function makeService(ttlMs = DAY_MS, startMs = 1_700_000_000_000) {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-auth-'));
  const db = openMigratedDatabase(join(dir, 'test.db'));
  const clock = fakeClock(startMs);
  const service = createAuthService({ db, clock, sessionTtlMs: ttlMs });
  return {
    service,
    clock,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('auth: 注册成功不创建会话；重名 409', () => {
  const { service, db, cleanup } = makeService();
  const created = service.register({ username: 'alice', password: 'Password@123' });
  assert.equal(created.ok, true);
  assert.equal(countSessions(db), 0); // Q2：注册不建会话
  const dup = service.register({ username: 'alice', password: 'Password@123' });
  assert.equal(dup.ok, false);
  assert.equal(dup.status, 409);
  cleanup();
});

test('auth: 登录成功签发 token 与 expiresAt=now+TTL', () => {
  const { service, clock, cleanup } = makeService();
  service.register({ username: 'alice', password: 'Password@123' });
  const result = service.login({ username: 'alice', password: 'Password@123' });
  assert.equal(result.ok, true);
  assert.equal(result.user.username, 'alice');
  assert.equal(result.expiresAt, clock.now() + DAY_MS);
  assert.equal(typeof result.token, 'string');
  cleanup();
});

test('auth: 用户不存在与密码错误返回逐字段一致的失败结果（防枚举）', () => {
  const { service, cleanup } = makeService();
  service.register({ username: 'alice', password: 'Password@123' });
  const noUser = service.login({ username: 'bob', password: 'Password@123' });
  const wrongPass = service.login({ username: 'alice', password: 'WrongPass@1' });
  assert.deepEqual(noUser, INVALID_CREDENTIALS);
  assert.deepEqual(wrongPass, INVALID_CREDENTIALS);
  cleanup();
});

test('auth: 24h 绝对过期——now+24h-1ms 有效、now+24h 无效', () => {
  const { service, clock, cleanup } = makeService();
  service.register({ username: 'alice', password: 'Password@123' });
  const { token } = service.login({ username: 'alice', password: 'Password@123' });
  clock.advance(DAY_MS - 1);
  assert.ok(service.resolveSession(token), '24h 前 1ms 仍应有效');
  clock.advance(1);
  assert.equal(service.resolveSession(token), null, '满 24h 必须失效');
  cleanup();
});

test('auth: 认证活动不延长 expiresAt（不续期）', () => {
  const { service, clock, db, cleanup } = makeService();
  service.register({ username: 'alice', password: 'Password@123' });
  const { token, expiresAt } = service.login({ username: 'alice', password: 'Password@123' });
  clock.advance(3600_000); // 1 小时后活动
  const session = service.resolveSession(token);
  assert.equal(session.expiresAt, expiresAt, 'expiresAt 落库后不变');
  const row = db.prepare('SELECT expires_at FROM sessions').get();
  assert.equal(Number(row.expires_at), expiresAt);
  cleanup();
});

test('auth: 幂等注销——重复注销结果一致且会话立即失效', () => {
  const { service, cleanup } = makeService();
  service.register({ username: 'alice', password: 'Password@123' });
  const { token } = service.login({ username: 'alice', password: 'Password@123' });
  assert.deepEqual(service.logout(token), { ok: true });
  assert.equal(service.resolveSession(token), null);
  assert.deepEqual(service.logout(token), { ok: true }); // 重复注销
  assert.deepEqual(service.logout(undefined), { ok: true }); // 无会话
  assert.deepEqual(service.logout('forged-token'), { ok: true }); // 伪造
  cleanup();
});

test('auth: 多会话隔离——注销 A 不影响 B', () => {
  const { service, cleanup } = makeService();
  service.register({ username: 'alice', password: 'Password@123' });
  const a = service.login({ username: 'alice', password: 'Password@123' });
  const b = service.login({ username: 'alice', password: 'Password@123' });
  assert.notEqual(a.token, b.token);
  service.logout(a.token);
  assert.equal(service.resolveSession(a.token), null);
  assert.ok(service.resolveSession(b.token), '会话 B 必须仍有效');
  cleanup();
});

test('auth: cleanupExpiredSessions 只删过期行并返回删除数', () => {
  const { service, clock, db, cleanup } = makeService();
  service.register({ username: 'alice', password: 'Password@123' });
  service.login({ username: 'alice', password: 'Password@123' });
  clock.advance(DAY_MS + 1);
  service.register({ username: 'bob', password: 'Password@123' });
  service.login({ username: 'bob', password: 'Password@123' }); // 新会话未过期
  const removed = service.cleanupExpiredSessions();
  assert.equal(removed, 1);
  assert.equal(countSessions(db), 1);
  cleanup();
});

test('auth: 伪造 token 解析为 null', () => {
  const { service, cleanup } = makeService();
  assert.equal(service.resolveSession('nonexistent-token'), null);
  assert.equal(service.resolveSession(''), null);
  assert.equal(service.resolveSession(undefined), null);
  cleanup();
});
