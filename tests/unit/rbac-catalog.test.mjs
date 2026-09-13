/**
 * T-02 权限目录与启动同步单测（AC-13/AC-14、D-04、AD-06）：
 * 目录常量结构合法（key 唯一、<module>:<action> 格式、apis 非空）；
 * syncPermissionCatalog 幂等（二次执行返回空 diff）；模拟目录新增 key 后 super_admin 自动覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERMISSION_CATALOG,
  SUPER_ADMIN_ROLE_KEY,
  catalogGroups,
  catalogKeys,
  syncPermissionCatalog,
} from '../../server/permissions.mjs';
import { openMigratedDatabase } from '../../server/migrations.mjs';

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-catalog-'));
  const db = openMigratedDatabase(join(dir, 'test.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('catalog: 目录常量结构合法——key 唯一、<module>:<action> 格式、apis 非空、模块元数据齐全', () => {
  const keys = catalogKeys();
  assert.equal(new Set(keys).size, keys.length, 'key 必须唯一');
  assert.equal(keys.length, 10, '需求级权限矩阵固定 10 项（D-05）');
  for (const item of PERMISSION_CATALOG) {
    assert.match(item.key, /^[a-z]+:[a-z_]+$/, `key 格式：<module>:<action> —— ${item.key}`);
    assert.ok(item.key.startsWith(`${item.module}:`), `key 前缀须等于 module：${item.key}`);
    assert.ok(item.moduleName && item.name && item.description, `展示元数据齐全：${item.key}`);
    assert.ok(Array.isArray(item.apis) && item.apis.length > 0, `每个 key 至少守卫一个真实端点：${item.key}`);
    for (const api of item.apis) assert.match(api, /^(GET|POST|PUT|DELETE) \/api\//, `apis 形如 "METHOD /path"：${api}`);
  }
  const groups = catalogGroups();
  const modules = groups.map((g) => g.module);
  assert.deepEqual(modules, ['user', 'role', 'permission', 'audit'], '四个模块分组');
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 10);
});

test('catalog-sync: 启动同步幂等——首次空 diff（迁移已种子），二次执行同样空 diff', () =>
  withDb((db) => {
    const first = syncPermissionCatalog(db);
    assert.deepEqual(first, { addedKeys: [], grantedToSuperAdmin: [] }, '迁移后同步应无差异');
    const second = syncPermissionCatalog(db);
    assert.deepEqual(second, { addedKeys: [], grantedToSuperAdmin: [] }, '二次执行幂等');
  }));

test('catalog-sync: 模拟目录新增 key 后 super_admin 自动覆盖（D-04），元数据 upsert 只增不删', () =>
  withDb((db) => {
    // 人为制造漂移：删一行 super_admin 授权 + 改一行元数据（模拟旧库升级/历史脏数据）
    const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(SUPER_ADMIN_ROLE_KEY);
    db.prepare('DELETE FROM role_permissions WHERE role_id = ? AND permission_key = ?').run(Number(role.id), 'audit:read');
    db.prepare("UPDATE permissions SET name = '脏数据' WHERE key = 'user:read'").run();
    const diff = syncPermissionCatalog(db);
    assert.deepEqual(diff.grantedToSuperAdmin, ['audit:read'], '缺失授权被补齐');
    const meta = db.prepare('SELECT name FROM permissions WHERE key = ?').get('user:read');
    assert.equal(meta.name, '查看用户', '元数据以代码目录为准被纠正');
    const granted = Number(
      db.prepare('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = ?').get(Number(role.id)).n,
    );
    assert.equal(granted, PERMISSION_CATALOG.length, 'super_admin 恢复全覆盖');
  }));
