/**
 * 云枢后台前端（原生 JS，AD-10）：
 * 单页三视图（登录/注册/欢迎）同一 URL 由 JS 切换；统一 fetch 封装，任何受保护接口 401 → 回登录视图；
 * 登录失败 401/5xx/网络三路径一致清空密码框、保留用户名框（Q4）；密码默认隐藏 + 显隐切换（REQ-007）。
 * 核心逻辑导出以便 DOM 替身测试；浏览器环境自动初始化。
 */

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

  /** 统一 fetch 封装：任何受保护接口 401 → 回登录视图（咨询 A3）。 */
  async function apiFetch(path, options = {}, { protectedCall = false } = {}) {
    let response;
    try {
      response = await fetchImpl(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
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

  /** 进入欢迎视图前先经 /api/me 确认会话（REQ-005、Q3）。 */
  async function enterWelcome() {
    const result = await apiFetch('/api/me', { method: 'GET' }, { protectedCall: true });
    if (result.status === 200 && result.body) {
      welcomeUsername.textContent = result.body.user.username;
      if (result.body.session && typeof result.body.session.expiresAt === 'number') {
        welcomeExpires.textContent = `会话有效期至 ${new Date(result.body.session.expiresAt).toLocaleString()}`;
        welcomeExpires.hidden = false;
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

  logoutButton.addEventListener('click', async () => {
    // 幂等注销：服务端一律 200，前端回登录视图（AC-06）
    await apiFetch('/api/logout', { method: 'POST', body: '{}' });
    showView('login');
  });

  doc.getElementById('goto-register').addEventListener('click', () => {
    hideError(loginError);
    hideError(loginNotice);
    showView('register');
  });
  doc.getElementById('goto-login').addEventListener('click', () => showView('login'));

  // 页面加载：已认证 → 欢迎视图；未认证 → 登录视图
  void enterWelcome();

  return { showView, apiFetch, enterWelcome };
}

// 浏览器环境自动初始化；DOM 替身测试注入时不执行
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initApp(document, window.fetch.bind(window));
}
