/**
 * 管理接口输入校验单测（架构 §4.3；AC-19/AC-21 边界）：
 * 角色载荷边界（名称/标识/说明/保留字）、启停载荷、roleIds/permissionKeys 载荷（未知/重复/类型/长度上限）、
 * 分页与审计筛选参数解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAuditQuery,
  parseListQuery,
  validatePermissionKeysPayload,
  validateRoleIdsPayload,
  validateRolePayload,
  validateStatusPayload,
} from '../../server/validation.mjs';
import { catalogKeySet } from '../../server/permissions.mjs';
import { AUDIT_ACTIONS } from '../../server/audit-service.mjs';

test('validation-rbac: 角色载荷——合法通过，名称去空白', () => {
  const ok = validateRolePayload({ name: '  运营专员  ', key: 'ops_lead', description: '运营' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, '运营专员', '名称去空白');
  assert.equal(validateRolePayload({ name: '角色', key: 'ab' }).value.description, '', '说明缺省为空串');
});

test('validation-rbac: 角色载荷——边界与保留字逐条命中', () => {
  assert.equal(validateRolePayload({ name: '', key: 'ab' }).fields.name, '角色名称为必填项');
  assert.ok(validateRolePayload({ name: 'x'.repeat(51), key: 'ab' }).fields.name.includes('1–50'));
  assert.ok(validateRolePayload({ name: 'a', key: 'a' }).fields.key.includes('2–50'));
  assert.ok(validateRolePayload({ name: 'a', key: '1abc' }).fields.key.includes('小写字母开头'));
  assert.ok(validateRolePayload({ name: 'a', key: 'ABC' }).fields.key.includes('小写字母开头'));
  assert.equal(validateRolePayload({ name: 'a', key: 'super_admin' }).fields.key, '该标识为内置保留字，不可使用');
  assert.ok(validateRolePayload({ name: 'a', key: 'ab', description: 'x'.repeat(201) }).fields.description.includes('200'));
  assert.ok(validateRolePayload(null).fields.body);
  assert.ok(validateRolePayload({ name: 'a', key: 'ab', description: 5 }).fields.description);
});

test('validation-rbac: 启停载荷——仅 active/disabled', () => {
  assert.equal(validateStatusPayload({ status: 'active' }).ok, true);
  assert.equal(validateStatusPayload({ status: 'disabled' }).ok, true);
  assert.ok(validateStatusPayload({ status: 'banned' }).fields.status);
  assert.ok(validateStatusPayload({}).fields.status);
  assert.ok(validateStatusPayload([]).fields.body);
});

test('validation-rbac: roleIds——非数组/非整数/重复/超长整体拒绝（AC-21）', () => {
  assert.ok(validateRoleIdsPayload({}, { maxCount: 10 }).fields.roleIds);
  assert.ok(validateRoleIdsPayload({ roleIds: [1, 'a'] }, { maxCount: 10 }).fields.roleIds);
  assert.ok(validateRoleIdsPayload({ roleIds: [1, 0, -2] }, { maxCount: 10 }).fields.roleIds);
  assert.ok(validateRoleIdsPayload({ roleIds: [1, 1] }, { maxCount: 10 }).fields.roleIds.includes('重复'));
  assert.ok(validateRoleIdsPayload({ roleIds: [1, 2, 3] }, { maxCount: 2 }).fields.roleIds.includes('不得超过'));
  assert.equal(validateRoleIdsPayload({ roleIds: [] }, { maxCount: 10 }).ok, true, '空数组合法（全撤销）');
  assert.equal(validateRoleIdsPayload({ roleIds: [3, 1] }, { maxCount: 10 }).ok, true);
});

test('validation-rbac: permissionKeys——未知/重复/非字符串/超长整体拒绝并列出清单（AC-19）', () => {
  const catalog = catalogKeySet();
  assert.ok(validatePermissionKeysPayload({ permissionKeys: 'user:read' }, { catalogKeys: catalog }).fields.permissionKeys);
  assert.ok(validatePermissionKeysPayload({ permissionKeys: [1] }, { catalogKeys: catalog }).fields.permissionKeys);
  const dup = validatePermissionKeysPayload({ permissionKeys: ['user:read', 'user:read'] }, { catalogKeys: catalog });
  assert.ok(dup.fields.permissionKeys.includes('重复'));
  const unknown = validatePermissionKeysPayload(
    { permissionKeys: ['user:read', 'ghost:hack', 'root:all'] },
    { catalogKeys: catalog },
  );
  assert.ok(unknown.fields.permissionKeys.includes('ghost:hack'));
  assert.ok(unknown.fields.permissionKeys.includes('root:all'), '未知 key 清单完整');
  const over = validatePermissionKeysPayload(
    { permissionKeys: [...catalog, 'x:y'].slice(0, catalog.size + 1) },
    { catalogKeys: catalog },
  );
  assert.ok(over.fields.permissionKeys, '长度超目录上限被拒');
  assert.equal(validatePermissionKeysPayload({ permissionKeys: [] }, { catalogKeys: catalog }).ok, true);
});

test('validation-rbac: 分页参数——默认 1/20，非法 400，上限 50', () => {
  assert.deepEqual(parseListQuery(new URLSearchParams('')).value, { page: 1, pageSize: 20, q: '' });
  assert.deepEqual(parseListQuery(new URLSearchParams('page=2&pageSize=50&q=abc')).value, { page: 2, pageSize: 50, q: 'abc' });
  assert.ok(parseListQuery(new URLSearchParams('page=0')).fields.page);
  assert.ok(parseListQuery(new URLSearchParams('page=-1')).fields.page);
  assert.ok(parseListQuery(new URLSearchParams('pageSize=51')).fields.pageSize);
  assert.ok(parseListQuery(new URLSearchParams('pageSize=0')).fields.pageSize);
  assert.ok(parseListQuery(new URLSearchParams(`q=${'x'.repeat(65)}`)).fields.q);
});

test('validation-rbac: 审计筛选——action 精确合法集、from/to 毫秒整数、组合解析', () => {
  const actions = new Set(Object.values(AUDIT_ACTIONS));
  const ok = parseAuditQuery(new URLSearchParams('actor=ad&target=u1&action=role.create&from=100&to=200&page=2'), actions);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { actor: 'ad', target: 'u1', action: 'role.create', from: 100, to: 200, page: 2, pageSize: 20 });
  assert.ok(parseAuditQuery(new URLSearchParams('action=no.such'), actions).fields.action);
  assert.ok(parseAuditQuery(new URLSearchParams('from=abc'), actions).fields.from);
  assert.ok(parseAuditQuery(new URLSearchParams('to=12.5'), actions).fields.to);
  const empty = parseAuditQuery(new URLSearchParams(''), actions);
  assert.deepEqual(empty.value, { actor: undefined, target: undefined, action: undefined, from: undefined, to: undefined, page: 1, pageSize: 20 });
});
