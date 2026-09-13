import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDummyHash, hashPassword, verifyPassword } from '../../server/passwords.mjs';
import { generateToken, hashToken, TOKEN_RANDOM_BYTES } from '../../server/tokens.mjs';

test('passwords: 正确口令校验通过，错误口令失败', () => {
  const stored = hashPassword('Password@123');
  assert.equal(verifyPassword('Password@123', stored), true);
  assert.equal(verifyPassword('Password@124', stored), false);
});

test('passwords: 同口令两次哈希盐不同', () => {
  const a = hashPassword('Password@123');
  const b = hashPassword('Password@123');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt:16384:8:1:/);
  // 存储串不含明文
  assert.ok(!a.includes('Password@123'));
});

test('passwords: 畸形存储串返回 false 而非抛异常', () => {
  for (const bad of ['', 'not-a-hash', 'scrypt:1:2:3', null, undefined, 42, 'scrypt:a:b:c:x:y']) {
    assert.equal(verifyPassword('whatever', bad), false, String(bad));
  }
});

test('passwords: dummy 哈希可参与同等校验且恒失败于真实口令之外的输入', () => {
  const dummy = getDummyHash();
  assert.match(dummy, /^scrypt:/);
  assert.equal(verifyPassword('Password@123', dummy), false);
});

test('tokens: 两次生成不同且解码后 32 字节', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64url').length, TOKEN_RANDOM_BYTES);
  assert.equal(TOKEN_RANDOM_BYTES, 32);
});

test('tokens: 哈希为 64 字符十六进制且稳定', () => {
  const token = generateToken();
  const hash = hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashToken(token), hash);
  assert.ok(!hash.includes(token));
});
