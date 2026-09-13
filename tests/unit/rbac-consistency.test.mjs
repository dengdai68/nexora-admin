/**
 * AC-14 一致性断言（T-08）：权限目录 ⇄ 服务端受保护路由双向映射——
 * 目录中每个 key 的 apis 声明都存在真实路由且该路由守卫同一 key；
 * 每个受保护管理路由的 "METHOD path" 都出现在其所需 key 的 apis 声明中。
 * 分组节点（module）不是权限，不出现在任何守卫声明中。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ROUTES_META } from '../../server/admin-routes.mjs';
import { PERMISSION_CATALOG, catalogKeys } from '../../server/permissions.mjs';

test('consistency: 目录 key ⇄ 受保护管理路由双向相等（无虚假权限/无漏守端点）', () => {
  const catalogApiMap = new Map(); // key -> Set("METHOD path")
  for (const item of PERMISSION_CATALOG) {
    catalogApiMap.set(item.key, new Set(item.apis));
  }
  const routeSet = new Set(ADMIN_ROUTES_META.map((r) => `${r.method} ${r.path}`));

  // 正向：目录声明的每个 api 必须是真实受保护路由且守卫同一 key
  for (const item of PERMISSION_CATALOG) {
    for (const api of item.apis) {
      assert.ok(routeSet.has(api), `目录声明的端点不存在：${api}（${item.key}）`);
      const route = ADMIN_ROUTES_META.find((r) => `${r.method} ${r.path}` === api);
      assert.equal(route.permission, item.key, `端点 ${api} 守卫 key 与目录声明不一致`);
    }
  }
  // 反向：每条受保护管理路由必须出现在其所需 key 的 apis 声明中
  for (const route of ADMIN_ROUTES_META) {
    const declared = catalogApiMap.get(route.permission);
    assert.ok(declared, `路由所需 key 不在目录中：${route.permission}`);
    assert.ok(
      declared.has(`${route.method} ${route.path}`),
      `路由 ${route.method} ${route.path} 未在 ${route.permission} 的 apis 声明中`,
    );
  }
});

test('consistency: 目录 key 集合与路由守卫 key 集合一致（每个 key 至少守卫一个端点）', () => {
  const guardedKeys = new Set(ADMIN_ROUTES_META.map((r) => r.permission));
  for (const key of catalogKeys()) {
    assert.ok(guardedKeys.has(key), `目录 key 未守卫任何端点：${key}`);
  }
  for (const key of guardedKeys) {
    assert.ok(catalogKeys().includes(key), `守卫了目录外 key：${key}`);
  }
  // 分组节点不是权限
  for (const module of ['user', 'role', 'permission', 'audit']) {
    assert.ok(!guardedKeys.has(module), `分组节点不得作为权限守卫：${module}`);
  }
});
