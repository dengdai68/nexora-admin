/**
 * T-10 权限树状态机纯函数单测（§8.2；AC-15~AC-18）：
 * 父子联动、半选态、全选/取消全选、搜索范围隔离（全选当前结果 vs 全选全部）、
 * 已选计数、目录外初始 key 忽略、分组节点不隐含授予。
 * DOM 渲染与真实浏览器证据由 e2e/测试节点另行覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTreeState } from '../../web/admin-roles.js';

/** 构造与真实目录同构的测试目录（2 组，user 组 3 项 / role 组 2 项）。 */
function makeCatalog() {
  return [
    {
      module: 'user',
      name: '用户管理',
      items: [
        { key: 'user:read', name: '查看用户', description: '列表详情' },
        { key: 'user:status', name: '启停用户', description: '禁用即撤会话' },
        { key: 'user:assign_roles', name: '用户授权', description: '分配角色' },
      ],
    },
    {
      module: 'role',
      name: '角色管理',
      items: [
        { key: 'role:read', name: '查看角色', description: '列表详情' },
        { key: 'role:create', name: '新建角色', description: '创建自定义角色' },
      ],
    },
  ];
}

test('tree: 父子联动与半选态（AC-15）', () => {
  const tree = createTreeState(makeCatalog());
  assert.equal(tree.groupState('user'), 'unchecked');
  tree.toggleLeaf('user:read');
  assert.equal(tree.groupState('user'), 'indeterminate', '部分勾选 → 半选');
  tree.toggleGroup('user'); // 未满 → 全选该组
  assert.equal(tree.groupState('user'), 'checked');
  assert.deepEqual(tree.checkedKeys(), ['user:assign_roles', 'user:read', 'user:status']);
  assert.equal(tree.groupState('role'), 'unchecked', '其他组不受影响');
  tree.toggleGroup('user'); // 已满 → 全清该组
  assert.equal(tree.groupState('user'), 'unchecked');
  assert.equal(tree.count(), 0);
});

test('tree: 全选全部/取消全选作用于整个目录，计数准确（AC-16）', () => {
  const tree = createTreeState(makeCatalog(), ['role:read']);
  assert.equal(tree.count(), 1);
  tree.selectAll();
  assert.equal(tree.count(), 5, '全选全部覆盖所有目录 key');
  assert.equal(tree.groupState('user'), 'checked');
  assert.equal(tree.groupState('role'), 'checked');
  tree.clearAll();
  assert.equal(tree.count(), 0);
  assert.deepEqual(tree.checkedKeys(), []);
});

test('tree: 搜索态「全选当前结果」只操作可见匹配并保留筛选外已选（AC-17）', () => {
  const tree = createTreeState(makeCatalog(), ['user:status']); // 筛选外已选
  tree.setFilter('授权');
  assert.deepEqual(tree.visibleKeys(), ['user:assign_roles'], '按名称匹配');
  tree.selectVisible();
  assert.deepEqual(tree.checkedKeys(), ['user:assign_roles', 'user:status'], '可见匹配并入，筛选外已选保留');
  tree.clearVisible();
  assert.deepEqual(tree.checkedKeys(), ['user:status'], '取消当前结果只清可见匹配');
  tree.setFilter('');
  assert.equal(tree.visibleKeys().length, 5, '清空筛选恢复全部可见');
});

test('tree: 搜索按 key/说明匹配且大小写不敏感', () => {
  const tree = createTreeState(makeCatalog());
  tree.setFilter('USER:READ');
  assert.deepEqual(tree.visibleKeys(), ['user:read'], '按 key 大小写不敏感');
  tree.setFilter('禁用');
  assert.deepEqual(tree.visibleKeys(), ['user:status'], '按说明匹配');
  tree.setFilter('不存在的词');
  assert.deepEqual(tree.visibleKeys(), []);
  assert.deepEqual(tree.visibleGroups(), [], '无匹配时无可见分组');
});

test('tree: 初始回显忽略目录外 key（目录唯一权威，AC-18 回显口径）', () => {
  const tree = createTreeState(makeCatalog(), ['user:read', 'ghost:hack']);
  assert.deepEqual(tree.checkedKeys(), ['user:read'], '目录外 key 被忽略');
  assert.equal(tree.isChecked('ghost:hack'), false);
  tree.toggleLeaf('ghost:hack'); // 未知 key 不可勾选
  assert.equal(tree.count(), 1);
});

test('tree: 分组节点仅组织展示——勾选组不引入目录外权限，提交载荷仅叶子 key', () => {
  const tree = createTreeState(makeCatalog());
  tree.toggleGroup('user');
  tree.toggleGroup('role');
  const submitted = tree.checkedKeys();
  assert.equal(submitted.length, 5);
  assert.ok(submitted.every((key) => key.includes(':')), '提交集全部为叶子权限 key');
  assert.ok(!submitted.includes('user') && !submitted.includes('role'), '分组名不出现在提交集');
});
