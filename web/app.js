/**
 * 云枢后台前端（原生 JS，AD-10）：
 * 单页四视图（登录/注册/欢迎/后台管理）同一 URL 由 JS 切换；统一 fetch 封装，任何受保护接口 401 → 回登录视图；
 * 登录失败 401/5xx/网络三路径一致清空密码框、保留用户名框（Q4）；密码默认隐藏 + 显隐切换（REQ-007）。
 * NEXORA-RBAC-011：登录/me 后拉取 /api/me/permissions（AD-09），无任何管理权限保持既有欢迎视图（不出现管理入口）；
 * 管理入口与导航按权限渲染（服务端守卫为唯一权威）；写方法统一注入 X-Nexora-CSRF 头（AD-03）。
 * 核心逻辑导出以便 DOM 替身测试；浏览器环境自动初始化。
 */
import { ADMIN_VIEWS, initAdmin } from './admin.js';

/** 登录失败三路径文案（401 通用 / 5xx / 网络异常，Q4 + 咨询 B4）。 */
export const LOGIN_MESSAGES = Object.freeze({
  credentials: '用户名或密码错误',
  server: '服务异常，请稍后重试',
  network: '网络异常，请检查连接后重试',
});

/**
 * Q4 口径：任何登录失败一律清空密码框、保留用户名框。
 * @param {{value:string}} passwordEl
 */
export function clearPasswordKeepUsername(passwordEl) {
  passwordEl.value = '';
}

/**
 * 按失败路径给出提示文案。
 * @param {{status?: number, networkError?: boolean}} failure
 * @returns {string}
 */
export function describeLoginFailure(failure) {
  if (failure.networkError) return LOGIN_MESSAGES.network;
  if (failure.status === 401) return LOGIN_MESSAGES.credentials;
  if (typeof failure.status === 'number' && failure.status >= 500) return LOGIN_MESSAGES.server;
  return LOGIN_MESSAGES.server;
}

/**
 * 初始化应用。
 * @param {Document} doc DOM 文档（测试可注入替身）
 * @param {Function} fetchImpl fetch 实现（测试可注入）
 */
export function initApp(doc, fetchImpl) {
  const views = {
    login: doc.getElementById('view-login'),
    register: doc.getElementById('view-register'),
    welcome: doc.getElementById('view-welcome'),
    admin: doc.getElementById('view-admin'),
  };
  const loginForm = doc.getElementById('login-form');
  const registerForm = doc.getElementById('register-form');
  const loginUsername = doc.getElementById('login-username');
  const loginPassword = doc.getElementById('login-password');
  const loginError = doc.getElementById('login-error');
  const loginNotice = doc.getElementById('login-notice');
  const registerUsername = doc.getElementById('register-username');
  const registerPassword = doc.getElementById('register-password');
  const registerError = doc.getElementById('register-error');
  const registerUsernameHint = doc.getElementById('register-username-hint');
  const registerPasswordHint = doc.getElementById('register-password-hint');
  const welcomeUsername = doc.getElementById('welcome-username');
  const welcomeExpires = doc.getElementById('welcome-expires');
  const logoutButton = doc.getElementById('logout-button');
  const gotoAdminButton = doc.getElementById('goto-admin');

  /** 管理壳（懒初始化，避免无权限用户加载管理逻辑）；当前有效权限缓存。 */
  let adminShell = null;
  let currentPermissions = [];

  /** 视图切换：同 URL，仅切换区块可见性。 */
  function showView(name) {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  }

  function showError(el, message) {
    el.textContent = message;
    el.hidden = false;
  }

  function hideError(el) {
    el.textContent = '';
    el.hidden = true;
  }

  /** 密码显隐切换（纯前端，不改变提交内容，REQ-007）。 */
  for (const button of doc.querySelectorAll('.toggle-visibility')) {
    button.addEventListener('click', () => {
      const input = doc.getElementById(button.dataset.target);
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.textContent = reveal ? '隐藏' : '显示';
    });
  }

  /** 统一 fetch 封装：写方法注入 X-Nexora-CSRF 头（AD-03）；任何受保护接口 401 → 回登录视图（咨询 A3）。 */
  async function apiFetch(path, options = {}, { protectedCall = false } = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) headers['X-Nexora-CSRF'] = '1';
    let response;
    try {
      response = await fetchImpl(path, {
        ...options,
        headers,
      });
    } catch {
      return { networkError: true, status: 0, body: null };
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (protectedCall && response.status === 401) {
      showView('login');
    }
    return { networkError: false, status: response.status, body };
  }

  /** 进入管理壳：渲染管理视图并按当前权限进入（导航按权限过滤）。 */
  function enterAdmin() {
    if (!adminShell) {
      adminShell = initAdmin(doc, apiFetch, {
        onBack: () => showView('welcome'),
        onLogout: doLogout,
      });
    }
    showView('admin');
    adminShell.enter(currentPermissions);
  }

  /** 幂等注销（服务端一律 200）并回登录视图。 */
  async function doLogout() {
    await apiFetch('/api/logout', { method: 'POST', body: '{}' });
    currentPermissions = [];
    showView('login');
  }

  /** 进入欢迎视图前先经 /api/me 确认会话（REQ-005、Q3）；随后拉取有效权限决定管理入口（AD-09）。 */
  async function enterWelcome() {
    const result = await apiFetch('/api/me', { method: 'GET' }, { protectedCall: true });
    if (result.status === 200 && result.body) {
      welcomeUsername.textContent = result.body.user.username;
      if (result.body.session && typeof result.body.session.expiresAt === 'number') {
        welcomeExpires.textContent = `会话有效期至 ${new Date(result.body.session.expiresAt).toLocaleString()}`;
        welcomeExpires.hidden = false;
      }
      // 拉取当前用户有效权限；失败按无权限处理（管理入口不出现，服务端仍逐 API 守卫）
      const perms = await apiFetch('/api/me/permissions', { method: 'GET' }, { protectedCall: true });
      currentPermissions =
        perms.status === 200 && perms.body && Array.isArray(perms.body.permissions) ? perms.body.permissions : [];
      const hasAdminEntry = ADMIN_VIEWS.some((view) => currentPermissions.includes(view.permission));
      gotoAdminButton.hidden = !hasAdminEntry;
      // hash 直达：#/admin/<view> 且持有任一管理权限 → 直接进入管理壳（刷新回显入口）
      if (hasAdminEntry && typeof window !== 'undefined' && /^#\/admin\//.test(window.location.hash || '')) {
        enterAdmin();
        return;
      }
      showView('welcome');
    }
    // 401 已由 apiFetch 统一切回登录视图
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError(loginError);
    hideError(loginNotice);
    const result = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: loginUsername.value, password: loginPassword.value }),
    });
    if (!result.networkError && result.status === 200) {
      clearPasswordKeepUsername(loginPassword);
      await enterWelcome();
      return;
    }
    // Q4：401 / 5xx / 网络失败三路径一致——清空密码框、保留用户名框
    clearPasswordKeepUsername(loginPassword);
    if (!result.networkError && result.status === 400) {
      const fields = (result.body && result.body.error && result.body.error.fields) || {};
      showError(loginError, Object.values(fields).join('；') || '参数不合法');
      return;
    }
    showError(
      loginError,
      describeLoginFailure({ status: result.status, networkError: result.networkError }),
    );
  });

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError(registerError);
    registerUsernameHint.hidden = true;
    registerPasswordHint.hidden = true;
    const result = await apiFetch('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: registerUsername.value, password: registerPassword.value }),
    });
    if (!result.networkError && result.status === 201) {
      // Q2：注册成功不自动登录 → 切回登录视图，引导手动登录；用户名可预填，密码清空
      const name = registerUsername.value;
      registerPassword.value = '';
      loginUsername.value = name;
      showView('login');
      showError(loginNotice, '注册成功，请登录');
      return;
    }
    clearPasswordKeepUsername(registerPassword);
    if (!result.networkError && result.status === 400) {
      const fields = (result.body && result.body.error && result.body.error.fields) || {};
      if (fields.username) {
        registerUsernameHint.textContent = fields.username;
        registerUsernameHint.hidden = false;
      }
      if (fields.password) {
        registerPasswordHint.textContent = fields.password;
        registerPasswordHint.hidden = false;
      }
      if (!fields.username && !fields.password) showError(registerError, '参数不合法');
      return;
    }
    if (!result.networkError && result.status === 409) {
      showError(registerError, (result.body && result.body.error && result.body.error.message) || '用户名已被占用');
      return;
    }
    showError(registerError, describeLoginFailure({ status: result.status, networkError: result.networkError }));
  });

  logoutButton.addEventListener('click', () => {
    // 幂等注销：服务端一律 200，前端回登录视图（AC-06）
    void doLogout();
  });

  gotoAdminButton.addEventListener('click', () => enterAdmin());

  doc.getElementById('goto-register').addEventListener('click', () => {
    hideError(loginError);
    hideError(loginNotice);
    showView('register');
  });
  doc.getElementById('goto-login').addEventListener('click', () => showView('login'));

  // 页面加载：已认证 → 欢迎视图；未认证 → 登录视图
  void enterWelcome();

  return { showView, apiFetch, enterWelcome, enterAdmin, getPermissions: () => [...currentPermissions] };
}

// 浏览器环境自动初始化；DOM 替身测试注入时不执行
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initApp(document, window.fetch.bind(window));
}
