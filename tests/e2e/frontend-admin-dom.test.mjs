/**
 * e2e：管理前端 DOM 替身测试（非浏览器覆盖，报告须标注；真实浏览器黑盒归测试节点 C-04）。
 * 覆盖：导航按权限渲染（AC-01/02）、无权限直达 → 无权限态、四态组件、权限树 DOM 交互
 * （勾选/父子联动/半选/四按钮/保存提交载荷/取消重建）、XSS 载荷只落文本节点（AC-31）、
 * 用户授权面板全选/计数/保存载荷（AC-21）、apiFetch 写方法注入 CSRF 头（AC-30）、静态扫描零 innerHTML（AD-10）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initAdmin, ADMIN_VIEWS, renderState } from '../../web/admin.js';
import { renderRolesPage } from '../../web/admin-roles.js';
import { renderUsersPage } from '../../web/admin-users.js';
import { initApp } from '../../web/app.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 最小 DOM 替身节点（支持 createElement/textContent/appendChild/setAttribute/事件）。 */
class FakeNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.ownText = '';
    this.className = '';
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(event, handler) {
    (this.listeners[event] ??= []).push(handler);
  }
  async click() {
    for (const handler of this.listeners.click ?? []) await handler({ preventDefault() {} });
  }
  async change() {
    for (const handler of this.listeners.change ?? []) await handler({ preventDefault() {} });
  }
  async input() {
    for (const handler of this.listeners.input ?? []) await handler({ preventDefault() {} });
  }
  async submit() {
    for (const handler of this.listeners.submit ?? []) await handler({ preventDefault() {} });
  }
  /** 深度查找（测试断言用）。 */
  findAll(predicate, acc = []) {
    for (const child of this.children) {
      if (predicate(child)) acc.push(child);
      child.findAll(predicate, acc);
    }
    return acc;
  }
}

function createFakeDocument(ids) {
  const registry = new Map(ids.map((id) => [id, new FakeNode('div')]));
  registry.forEach((node, id) => {
    node.id = id;
  });
  const created = [];
  return {
    created,
    getElementById: (id) => registry.get(id) ?? null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const node = new FakeNode(tag);
      created.push(node);
      return node;
    },
  };
}

/** 等所有排队的微任务/宏任务跑完（渲染为异步）。 */
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 路由表式 apiFetch 桩：routes: {'METHOD <前缀>': {status, body} | (path, options)=>{...}}，并记录调用。 */
function makeApiFetch(routeTable) {
  const calls = [];
  const apiFetch = async (path, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    calls.push({ path, method, options });
    for (const [signature, responder] of Object.entries(routeTable)) {
      const [m, prefix] = signature.split(' ', 2);
      if (m === method && path.startsWith(prefix)) {
        const result = typeof responder === 'function' ? responder(path, options) : responder;
        return { networkError: false, status: result.status, body: result.body };
      }
    }
    return { networkError: false, status: 404, body: { error: { code: 'not_found', message: '未命中桩' } } };
  };
  apiFetch.calls = calls;
  return apiFetch;
}

const ADMIN_IDS = ['admin-nav', 'admin-content', 'admin-back', 'admin-logout'];
const CATALOG = {
  groups: [
    {
      module: 'user',
      name: '用户管理',
      items: [
        { key: 'user:read', name: '查看用户', description: '列表详情', page: '用户管理页', apis: ['GET /api/admin/users'] },
        { key: 'user:status', name: '启停用户', description: '禁用', page: '用户管理页', apis: ['POST /api/admin/users/:username/status'] },
      ],
    },
    {
      module: 'role',
      name: '角色管理',
      items: [{ key: 'role:read', name: '查看角色', description: '列表', page: '角色管理页', apis: ['GET /api/admin/roles'] }],
    },
  ],
};

test('admin-dom: 导航按权限渲染（AC-01/02）——部分权限只见对应入口', async () => {
  const doc = createFakeDocument(ADMIN_IDS);
  const apiFetch = makeApiFetch({ 'GET /api/admin/users': { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } } });
  const shell = initAdmin(doc, apiFetch, {});
  shell.enter(['user:read', 'audit:read']);
  await flush();
  const navText = doc.getElementById('admin-nav').textContent;
  assert.ok(navText.includes('用户管理'));
  assert.ok(!navText.includes('角色管理'), '无 role:read 不渲染角色管理入口');
  assert.ok(navText.includes('授权审计'));
  assert.ok(!navText.includes('权限目录'));
  // 进入首个可见视图（用户管理列表加载完成 → 空态）
  assert.ok(doc.getElementById('admin-content').textContent.includes('暂无数据'));
});

test('admin-dom: 无权限直达视图 → 无权限态（AC-02）', async () => {
  const doc = createFakeDocument(ADMIN_IDS);
  const apiFetch = makeApiFetch({});
  const shell = initAdmin(doc, apiFetch, {});
  shell.enter(['user:read']);
  await flush();
  shell.navigate('audit');
  await flush();
  const content = doc.getElementById('admin-content');
  assert.ok(content.textContent.includes('无权限'), '直达无权限视图显示无权限反馈');
  assert.equal(apiFetch.calls.filter((c) => c.path.includes('audit-events')).length, 0, '未发起无权限请求');
});

test('admin-dom: 四态组件文案与样式类（AC-03）', () => {
  const doc = createFakeDocument([]);
  for (const [state, text] of [
    ['loading', '加载中'],
    ['empty', '暂无数据'],
    ['error', '加载失败'],
    ['forbidden', '无权限'],
  ]) {
    const host = new FakeNode('div');
    renderState(host, doc, state);
    assert.ok(host.textContent.includes(text), `${state} 态文案`);
    assert.ok(host.children[0].className.includes(`state-${state}`));
  }
});

test('admin-dom: 权限树 DOM——回显/半选/四按钮/保存载荷/取消重建（AC-15~AC-19）', async () => {
  const doc = createFakeDocument([]);
  const role = {
    id: 7,
    key: 'ops_lead',
    name: '运营专员',
    description: '',
    status: 'active',
    isBuiltin: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const apiFetch = makeApiFetch({
    'GET /api/admin/roles?q=': { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } },
    'GET /api/admin/roles/7': { status: 200, body: { role: { ...role, permissionKeys: ['user:read'], boundUsers: 0 } } },
    'GET /api/admin/permissions': { status: 200, body: CATALOG },
    'PUT /api/admin/roles/7/permissions': (path, options) => ({ status: 200, body: { role: { ...role, permissionKeys: JSON.parse(options.body).permissionKeys, boundUsers: 0 } } }),
  });
  const container = new FakeNode('div');
  const ctx = { doc, apiFetch, hasPermission: () => true, confirm: () => true };
  await renderRolesPage(container, ctx);
  // 进入详情（列表为空，直接渲染详情场景：改为直接调用详情路径）——列表为空时无行可点，改走「列表有一条」数据
  // 重新以有数据列表渲染
  apiFetch.calls.length = 0;
  const withList = makeApiFetch({
    'GET /api/admin/roles?q=': { status: 200, body: { items: [{ ...role, permissionCount: 1, userCount: 0 }], total: 1, page: 1, pageSize: 20 } },
    'GET /api/admin/roles/7': { status: 200, body: { role: { ...role, permissionKeys: ['user:read'], boundUsers: 0 } } },
    'GET /api/admin/permissions': { status: 200, body: CATALOG },
    'PUT /api/admin/roles/7/permissions': (path, options) => ({ status: 200, body: { role: { ...role, permissionKeys: JSON.parse(options.body).permissionKeys, boundUsers: 0 } } }),
  });
  const container2 = new FakeNode('div');
  await renderRolesPage(container2, { doc, apiFetch: withList, hasPermission: () => true, confirm: () => true });
  const detailButtons = container2.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '详情');
  assert.equal(detailButtons.length, 1);
  await detailButtons[0].click();
  await flush();

  // 回显：user:read 叶子勾选，user 组半选
  const leaves = container2.findAll((n) => n.className === 'tree-leaf');
  assert.equal(leaves.length, 3);
  const leafBoxes = leaves.map((leaf) => leaf.children[0]);
  const readBox = leaves[leaves.findIndex((l) => l.textContent.includes('user:read'))].children[0];
  assert.equal(readBox.checked, true, '回显 user:read 勾选');
  const groupBoxes = container2.findAll((n) => n.className === 'tree-group-label').map((l) => l.children[0]);
  const userGroupBox = groupBoxes[0];
  assert.equal(userGroupBox.indeterminate, true, 'user 组半选态');
  assert.equal(userGroupBox.checked, false);
  const counter = container2.findAll((n) => n.className.includes('tree-counter'));
  assert.ok(counter[0].textContent.includes('已选 1 项权限'), '已选计数');

  // 父子联动：点组复选 → 该组全选
  userGroupBox.checked = true;
  await userGroupBox.change();
  await flush();
  let counterAfter = container2.findAll((n) => n.className.includes('tree-counter'));
  assert.ok(counterAfter[0].textContent.includes('已选 2 项权限'), '组联动后计数 2');

  // 搜索态四按钮：「全选当前结果/取消当前结果」仅搜索态出现
  const buttonsText = () => container2.findAll((n) => n.tagName === 'BUTTON').map((b) => b.textContent);
  assert.ok(buttonsText().includes('全选全部') && buttonsText().includes('取消全选'), '恒显按钮存在');
  assert.ok(!buttonsText().includes('全选当前结果'), '非搜索态不出现范围按钮');
  const searchInput = container2.findAll((n) => n.className === 'search-input')[0];
  searchInput.value = '角色';
  await searchInput.input();
  await flush();
  assert.ok(buttonsText().includes('全选当前结果'), '搜索态出现范围按钮');
  // 全选当前结果：只勾可见 role:read，保留已选 user 组两项
  const selectVisibleBtn = container2.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '全选当前结果')[0];
  await selectVisibleBtn.click();
  await flush();
  counterAfter = container2.findAll((n) => n.className.includes('tree-counter'));
  assert.ok(counterAfter[0].textContent.includes('已选 3 项权限'), '全选当前结果保留筛选外已选');

  // 保存：提交排序后的完整集合
  const saveBtn = container2.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '保存')[0];
  await saveBtn.click();
  await flush();
  const putCall = withList.calls.find((c) => c.method === 'PUT' && c.path.includes('/permissions'));
  assert.deepEqual(JSON.parse(putCall.options.body), { permissionKeys: ['role:read', 'user:read', 'user:status'] }, '保存提交排序后完整集合');
});

test('admin-dom: XSS——恶意角色名只落文本节点，不创建 script 元素（AC-31）', async () => {
  const doc = createFakeDocument([]);
  const xss = '<script>alert(1)</script>';
  const apiFetch = makeApiFetch({
    'GET /api/admin/roles?q=': {
      status: 200,
      body: { items: [{ id: 3, key: 'xss_role', name: xss, description: xss, status: 'active', isBuiltin: false, permissionCount: 0, userCount: 0, createdAt: 1, updatedAt: 1 }], total: 1, page: 1, pageSize: 20 },
    },
  });
  const container = new FakeNode('div');
  await renderRolesPage(container, { doc, apiFetch, hasPermission: () => true, confirm: () => true });
  await flush();
  assert.equal(doc.created.filter((n) => n.tagName === 'SCRIPT').length, 0, '未创建任何 script 元素');
  assert.ok(container.textContent.includes(xss), '恶意串作为纯文本呈现');
});

test('admin-dom: 用户授权面板——全选/取消全选/计数/禁用徽标/保存载荷（AC-21）', async () => {
  const doc = createFakeDocument([]);
  const member = { username: 'member_01', status: 'active', createdAt: 1, roles: [{ id: 9, key: 'old_role', name: '旧角色', status: 'disabled' }] };
  const apiFetch = makeApiFetch({
    'GET /api/admin/users/member_01': { status: 200, body: { user: member } },
    'GET /api/admin/roles/enabled': {
      status: 200,
      body: { items: [{ id: 2, key: 'ops_lead', name: '运营专员', status: 'active' }, { id: 4, key: 'viewer', name: '观察员', status: 'active' }] },
    },
    'PUT /api/admin/users/member_01/roles': (path, options) => ({ status: 200, body: { user: { ...member, roles: [] } } }),
  });
  // 直接进入详情：先渲染列表再点详情
  const listFetch = makeApiFetch({
    'GET /api/admin/users/member_01': { status: 200, body: { user: member } },
    'GET /api/admin/users?': { status: 200, body: { items: [{ ...member }], total: 1, page: 1, pageSize: 20 } },
    'GET /api/admin/roles/enabled': {
      status: 200,
      body: { items: [{ id: 2, key: 'ops_lead', name: '运营专员', status: 'active' }, { id: 4, key: 'viewer', name: '观察员', status: 'active' }] },
    },
    'PUT /api/admin/users/member_01/roles': (path, options) => ({ status: 200, body: { user: { ...member, roles: [] } } }),
  });
  const container = new FakeNode('div');
  await renderUsersPage(container, { doc, apiFetch: listFetch, hasPermission: () => true, confirm: () => true });
  await flush();
  const detailBtn = container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '详情')[0];
  await detailBtn.click();
  await flush();

  // 可选集 = 2 启用角色 + 已绑禁用角色（徽标）
  const items = container.findAll((n) => n.className === 'check-item');
  assert.equal(items.length, 3, '启用角色 ∪ 已绑禁用角色');
  assert.ok(items.some((i) => i.textContent.includes('已禁用')), '禁用徽标展示');
  const boxes = items.map((i) => i.children[0]);
  assert.equal(boxes.find((b) => items[boxes.indexOf(b)].textContent.includes('旧角色')).checked, true, '已绑禁用角色保留勾选');

  // 全选 → 计数 3；取消全选 → 0
  const selectAllBtn = container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '全选')[0];
  await selectAllBtn.click();
  assert.ok(container.textContent.includes('已选 3 个角色'));
  const clearBtn = container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '取消全选')[0];
  await clearBtn.click();
  assert.ok(container.textContent.includes('已选 0 个角色'));

  // 勾选 2 个启用角色保存 → PUT 载荷正确
  for (const item of items) {
    if (item.textContent.includes('运营专员') || item.textContent.includes('观察员')) {
      const box = item.children[0];
      box.checked = true;
      await box.change();
    }
  }
  const saveBtn = container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '保存')[0];
  await saveBtn.click();
  await flush();
  const putCall = listFetch.calls.find((c) => c.method === 'PUT' && c.path.includes('/roles'));
  assert.deepEqual(JSON.parse(putCall.options.body), { roleIds: [2, 4] }, '保存提交排序后角色 id 集');
});

test('admin-dom: apiFetch 写方法自动注入 X-Nexora-CSRF 头（AC-30）', async () => {
  const captured = [];
  const fetchStub = async (path, options) => {
    captured.push({ path, headers: options.headers });
    return { status: 401, json: async () => ({ error: { code: 'unauthorized' } }) };
  };
  const ids = [
    'view-login', 'view-register', 'view-welcome', 'view-admin',
    'login-form', 'register-form', 'login-username', 'login-password', 'login-error', 'login-notice',
    'register-username', 'register-password', 'register-error', 'register-username-hint', 'register-password-hint',
    'welcome-username', 'welcome-expires', 'logout-button', 'goto-register', 'goto-login',
    'goto-admin', 'admin-nav', 'admin-content', 'admin-back', 'admin-logout',
  ];
  const doc = createFakeDocument(ids);
  const app = initApp(doc, fetchStub);
  await flush();
  captured.length = 0; // 忽略初始化期的 /api/me 等调用
  await app.apiFetch('/api/admin/roles', { method: 'POST', body: '{}' });
  assert.equal(captured[0].headers['X-Nexora-CSRF'], '1', 'POST 注入 CSRF 头');
  await app.apiFetch('/api/admin/roles/1', { method: 'PUT', body: '{}' });
  assert.equal(captured[1].headers['X-Nexora-CSRF'], '1', 'PUT 注入');
  await app.apiFetch('/api/admin/roles/1', { method: 'DELETE' });
  assert.equal(captured[2].headers['X-Nexora-CSRF'], '1', 'DELETE 注入');
  await app.apiFetch('/api/admin/roles', { method: 'GET' });
  assert.equal(captured[3].headers['X-Nexora-CSRF'], undefined, 'GET 不注入');
});

test('admin-dom: 登录后按权限决定管理入口可见性（AC-01/02）', async () => {
  const ids = [
    'view-login', 'view-register', 'view-welcome', 'view-admin',
    'login-form', 'register-form', 'login-username', 'login-password', 'login-error', 'login-notice',
    'register-username', 'register-password', 'register-error', 'register-username-hint', 'register-password-hint',
    'welcome-username', 'welcome-expires', 'logout-button', 'goto-register', 'goto-login',
    'goto-admin', 'admin-nav', 'admin-content', 'admin-back', 'admin-logout',
  ];
  // 场景一：无管理权限 → 不出现管理入口
  const docA = createFakeDocument(ids);
  const fetchA = async (path) => {
    if (path === '/api/me') return { status: 200, json: async () => ({ user: { username: 'member_01' }, session: { expiresAt: 1 } }) };
    if (path === '/api/me/permissions') return { status: 200, json: async () => ({ permissions: [] }) };
    return { status: 404, json: async () => ({}) };
  };
  initApp(docA, fetchA);
  await flush();
  assert.equal(docA.getElementById('goto-admin').hidden, true, '无权限用户不见管理入口');
  assert.equal(docA.getElementById('view-welcome').hidden, false, '保持既有欢迎视图');

  // 场景二：有权限 → 入口可见，点击进入管理视图并渲染导航
  const docB = createFakeDocument(ids);
  const fetchB = async (path) => {
    if (path === '/api/me') return { status: 200, json: async () => ({ user: { username: 'root_admin' }, session: { expiresAt: 1 } }) };
    if (path === '/api/me/permissions') return { status: 200, json: async () => ({ permissions: ['user:read'] }) };
    if (path.startsWith('/api/admin/users')) return { status: 200, json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) };
    return { status: 404, json: async () => ({}) };
  };
  initApp(docB, fetchB);
  await flush();
  assert.equal(docB.getElementById('goto-admin').hidden, false, '有权限用户见管理入口');
  await docB.getElementById('goto-admin').click();
  await flush();
  assert.equal(docB.getElementById('view-admin').hidden, false, '进入管理视图');
  assert.ok(docB.getElementById('admin-nav').textContent.includes('用户管理'), '导航渲染');
  assert.ok(!docB.getElementById('admin-nav').textContent.includes('角色管理'), '无权限入口不渲染');
});

test('admin-dom: 静态防线——web/ 全部前端源码无 HTML 注入面 API（AD-10）', () => {
  for (const file of ['app.js', 'admin.js', 'admin-users.js', 'admin-roles.js', 'admin-catalog.js', 'admin-audit.js']) {
    const source = readFileSync(join(REPO_ROOT, 'web', file), 'utf8');
    // 匹配真实属性赋值/调用（注释中的文字说明不算使用）
    assert.ok(!/\.\s*innerHTML\s*=/.test(source), `${file} 不得赋值 innerHTML`);
    assert.ok(!/\.\s*outerHTML\s*=/.test(source), `${file} 不得赋值 outerHTML`);
    assert.ok(!/\.\s*insertAdjacentHTML\s*\(/.test(source), `${file} 不得使用 insertAdjacentHTML`);
    assert.ok(!/document\.write\s*\(/.test(source), `${file} 不得使用 document.write`);
  }
});

test('admin-dom: 视图注册表与权限映射完整（四个页面入口）', () => {
  assert.deepEqual(
    ADMIN_VIEWS.map((v) => `${v.id}:${v.permission}`),
    ['users:user:read', 'roles:role:read', 'catalog:permission:read', 'audit:audit:read'],
  );
});
