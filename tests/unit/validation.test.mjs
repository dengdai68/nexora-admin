import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, validateCredentials } from '../../server/validation.mjs';

const GOOD = { username: 'alice_01', password: 'Password@123' };

test('validation: 合法输入通过', () => {
  const result = validateCredentials(GOOD);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, GOOD);
});

test('validation: 非对象/数组/null 结构被拒', () => {
  for (const body of [null, 'x', 42, [1, 2]]) {
    const result = validateCredentials(body);
    assert.equal(result.ok, false);
    assert.ok(result.fields.body);
  }
});

test('validation: 空用户名与空密码逐条命中 fields', () => {
  const result = validateCredentials({ username: '', password: '' });
  assert.equal(result.ok, false);
  assert.ok(result.fields.username);
  assert.ok(result.fields.password);
});

test('validation: 非字符串字段被拒', () => {
  const result = validateCredentials({ username: 123, password: true });
  assert.equal(result.ok, false);
  assert.ok(result.fields.username);
  assert.ok(result.fields.password);
});

test('validation: 用户名长度边界', () => {
  assert.equal(validateCredentials({ username: 'ab', password: GOOD.password }).ok, false);
  assert.equal(validateCredentials({ username: 'a'.repeat(33), password: GOOD.password }).ok, false);
  assert.equal(validateCredentials({ username: 'abc', password: GOOD.password }).ok, true);
  assert.equal(validateCredentials({ username: 'a'.repeat(32), password: GOOD.password }).ok, true);
});

test('validation: 用户名非法字符被拒', () => {
  for (const username of ['a b c', '张三疯', 'a@b.com', 'a.b']) {
    assert.equal(validateCredentials({ username, password: GOOD.password }).ok, false, username);
  }
  assert.equal(validateCredentials({ username: 'a-B_c9', password: GOOD.password }).ok, true);
});

test('validation: 密码长度边界', () => {
  assert.equal(validateCredentials({ username: GOOD.username, password: '1234567' }).ok, false);
  assert.equal(validateCredentials({ username: GOOD.username, password: 'x'.repeat(129) }).ok, false);
  assert.equal(validateCredentials({ username: GOOD.username, password: '12345678' }).ok, true);
  assert.equal(validateCredentials({ username: GOOD.username, password: 'x'.repeat(128) }).ok, true);
});

test('validation: fields 仅含校验结论，不泄露内部细节', () => {
  const result = validateCredentials({ username: '!!', password: '' });
  const serialized = JSON.stringify(result.fields);
  assert.ok(!serialized.includes('scrypt'));
  assert.ok(!serialized.includes('sql'));
  assert.ok(LIMITS.usernameMax === 32 && LIMITS.passwordMax === 128);
});
