/**
 * 前端 DOM 替身测试（非浏览器覆盖，报告须标注）：
 * 显隐切换、登录失败三路径清空密码保留用户名（Q4）、401 统一回登录视图、注册成功引导。
 * 真实浏览器黑盒交互由测试工程师另行覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeLoginFailure, initApp, LOGIN_MESSAGES } from '../../web/app.js';

class StubElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.type = 'text';
    this.dataset = {};
    this.listeners = {};
  }
  addEventListener(event, handler) {
    this.listeners[event] = handler;
  }
  async dispatch(event, payload = {}) {
    await this.listeners[event]({ preventDefault() {}, ...payload });
  }
  click() {
    return this.listeners.click ? this.listeners.click() : undefined;
  }
}

function buildDom() {
  const ids = [
    'view-login', 'view-register', 'view-welcome', 'view-admin',
    'login-form', 'register-form',
    'login-username', 'login-password', 'login-error', 'login-notice',
    'register-username', 'register-password', 'register-error',
    'register-username-hint', 'register-password-hint',
    'welcome-username', 'welcome-expires', 'logout-button',
    'goto-register', 'goto-login',
    'goto-admin', 'admin-nav', 'admin-content', 'admin-back', 'admin-logout',
  ];
  const elements = new Map(ids.map((id) => [id, new StubElement(id)]));
  elements.get('login-password').type = 'password';
  elements.get('register-password').type = 'password';
  const toggleLogin = new StubElement('toggle-login');
  toggleLogin.dataset.target = 'login-password';
  toggleLogin.textContent = '显示';
  const toggleRegister = new StubElement('toggle-register');
  toggleRegister.dataset.target = 'register-password';
  toggleRegister.textContent = '显示';
  return {
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: (selector) => (selector === '.toggle-visibility' ? [toggleLogin, toggleRegister] : []),
    elements,
  };
}

/** fetch 桩：handler(path, options) 返回 {status, body} 或抛网络错误。 */
function makeFetch(handler) {
  return async (path, options) => {
    const result = await handler(path, options);
    if (result.networkError) throw new Error('network down');
    return { status: result.status, json: async () => result.body ?? null };
  };
}

test('dom: 密码默认隐藏，显隐按钮切换 type 与文案（AC-11）', async () => {
  const doc = buildDom();
  const fetchStub = makeFetch(() => ({ status: 401, body: { error: { code: 'unauthorized' } } }));
  initApp(doc, fetchStub);
  const input = doc.getElementById('login-password');
  assert.equal(input.type, 'password', '密码框默认 type=password');
  const toggle = doc.querySelectorAll('.toggle-visibility')[0];
  toggle.click();
  assert.equal(input.type, 'text');
  assert.equal(toggle.textContent, '隐藏');
  toggle.click();
  assert.equal(input.type, 'password');
  assert.equal(toggle.textContent, '显示');
});

const LOGIN_401 = { status: 401, body: { error: { code: 'invalid_credentials', message: '用户名或密码错误' } } };

test('dom: 登录失败三路径（401/500/网络）一致清空密码框、保留用户名框（AC-04）', async () => {
  for (const scenario of [
    { name: '401', response: LOGIN_401, message: LOGIN_MESSAGES.credentials },
    { name: '500', response: { status: 500, body: { error: { code: 'internal_error' } } }, message: LOGIN_MESSAGES.server },
    { name: '网络', response: { networkError: true }, message: LOGIN_MESSAGES.network },
  ]) {
    const doc = buildDom();
    const fetchStub = makeFetch((path) => (path === '/api/me' ? { status: 401, body: {} } : scenario.response));
    initApp(doc, fetchStub);
    const username = doc.getElementById('login-username');
    const password = doc.getElementById('login-password');
    username.value = 'alice_01';
    password.value = 'Password@123';
    await doc.getElementById('login-form').dispatch('submit');
    assert.equal(password.value, '', `${scenario.name} 路径必须清空密码框`);
    assert.equal(username.value, 'alice_01', `${scenario.name} 路径必须保留用户名框`);
    const error = doc.getElementById('login-error');
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, scenario.message, `${scenario.name} 路径文案`);
  }
});

test('dom: 受保护接口 401 统一切回登录视图（咨询 A3）', async () => {
  const doc = buildDom();
  const fetchStub = makeFetch(() => ({ status: 401, body: { error: { code: 'unauthorized' } } }));
  const app = initApp(doc, fetchStub);
  await new Promise((resolve) => setImmediate(resolve)); // 等待初始化 enterWelcome
  assert.equal(doc.getElementById('view-login').hidden, false);
  assert.equal(doc.getElementById('view-welcome').hidden, true);
  const result = await app.apiFetch('/api/resource', {}, { protectedCall: true });
  assert.equal(result.status, 401);
  assert.equal(doc.getElementById('view-login').hidden, false);
});

test('dom: 登录成功进入欢迎视图并展示用户名与退出按钮（AC-03）', async () => {
  const doc = buildDom();
  const fetchStub = makeFetch((path) => {
    if (path === '/api/login') return { status: 200, body: { user: { username: 'alice_01' }, session: { expiresAt: Date.now() + 86_400_000 } } };
    if (path === '/api/me') return { status: 200, body: { user: { username: 'alice_01' }, session: { expiresAt: Date.now() + 86_400_000 } } };
    return { status: 404, body: {} };
  });
  initApp(doc, fetchStub);
  doc.getElementById('login-username').value = 'alice_01';
  doc.getElementById('login-password').value = 'Password@123';
  await doc.getElementById('login-form').dispatch('submit');
  assert.equal(doc.getElementById('view-welcome').hidden, false);
  assert.equal(doc.getElementById('welcome-username').textContent, 'alice_01');
  assert.ok(doc.getElementById('logout-button'), '退出按钮必须存在');
});

test('dom: 注册成功切回登录视图、提示手动登录、用户名预填密码清空（Q2）', async () => {
  const doc = buildDom();
  const fetchStub = makeFetch((path) => {
    if (path === '/api/register') return { status: 201, body: { user: { username: 'newbie_1' } } };
    return { status: 401, body: {} };
  });
  initApp(doc, fetchStub);
  doc.getElementById('register-username').value = 'newbie_1';
  doc.getElementById('register-password').value = 'Password@123';
  await doc.getElementById('register-form').dispatch('submit');
  assert.equal(doc.getElementById('view-login').hidden, false);
  assert.equal(doc.getElementById('login-notice').textContent, '注册成功，请登录');
  assert.equal(doc.getElementById('login-username').value, 'newbie_1');
  assert.equal(doc.getElementById('register-password').value, '');
});

test('dom: describeLoginFailure 三路径文案稳定', () => {
  assert.equal(describeLoginFailure({ status: 401 }), LOGIN_MESSAGES.credentials);
  assert.equal(describeLoginFailure({ status: 500 }), LOGIN_MESSAGES.server);
  assert.equal(describeLoginFailure({ status: 502 }), LOGIN_MESSAGES.server);
  assert.equal(describeLoginFailure({ networkError: true }), LOGIN_MESSAGES.network);
});
