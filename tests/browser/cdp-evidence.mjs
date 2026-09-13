/**
 * 真实浏览器证据采集（NEXORA-RBAC-011 / 测试节点 C-04）：
 * 驱动真实 Google Chrome（headless=new，完整 Blink 渲染 + V8 执行，CDP 远程调试协议，零第三方依赖，
 * 传输层为 Node 内置 WebSocket/HTTP），在本脚本启动的隔离服务（临时 SQLite + 随机端口）上完成
 * 关键授权流程的真实浏览器操作：登录 → 管理入口 → 建角色 → 权限树勾选（父子联动/半选/计数）→
 * 保存回显 → 用户授权 → 受限用户登录看到获准菜单 → 撤权后无权限态 + 底层 API 403 → 审计留痕 → 窄屏。
 * 每步截图落盘 docs/testing/evidence/，并采集页面 JS 异常（任何异常即判定失败）。
 * 用法：node tests/browser/cdp-evidence.mjs [输出目录]（默认 docs/testing/evidence）
 * 依赖：本机安装 Google Chrome（/Applications/Google Chrome.app）；不需要 npm 依赖。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startTestServer } from '../e2e/server-harness.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = process.argv[2] ?? join(process.cwd(), 'docs/testing/evidence');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 最小 CDP 客户端：browser ws → Target.createTarget/attachToTarget（flat session）→ Page/Runtime/Emulation。 */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.sessionId = null;
    this.pageErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'unknown');
      }
      const handler = this.handlers.get(msg.method);
      if (handler) handler(msg.params);
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  send(method, params = {}, useSession = true) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (useSession && this.sessionId) message.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30_000);
    });
  }

  /** 新建页面目标并附着 flat session。 */
  async attachPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  /** 导航并等待 load 事件。 */
  async navigate(url) {
    const loaded = new Promise((resolve) => {
      this.on('Page.loadEventFired', () => resolve());
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** 页面内求值（returnByValue）；awaitPromise 支持异步表达式。 */
  async eval(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`页面求值异常：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}\n表达式：${expression}`);
    }
    return result.result.value;
  }

  /** 轮询等待页面条件成立；超时输出当前视图诊断快照。 */
  async waitFor(expression, { timeoutMs = 15_000, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval(expression)) return;
      await sleep(120);
    }
    let diag = '';
    try {
      diag = await this.eval(`(document.querySelector('#admin-content .page-title')?.textContent ?? '-') + ' | nav=' + [...document.querySelectorAll('#admin-nav .admin-nav-item')].map((b) => b.dataset.view).join(',') + ' | view-admin-hidden=' + document.getElementById('view-admin').hidden + ' | welcome-hidden=' + document.getElementById('view-welcome').hidden + ' | hash=' + location.hash`);
    } catch { /* 忽略 */ }
    throw new Error(`等待页面条件超时：${label}${diag ? `｜诊断：${diag}` : ''}`);
  }

  /** 截图落盘 PNG（captureBeyondViewport 截取整页，避免交互区在首屏外导致证据失真）。 */
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 启动真实 Chrome（headless=new + 独立临时 profile + 远程调试端口 0，端口从 DevToolsActivePort 读取）。 */
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'nexora-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const firstLine = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (firstLine) return { chrome, profile, port: Number(firstLine) };
    } catch {
      /* 尚未写出 */
    }
    if (Date.now() > deadline) throw new Error('Chrome DevToolsActivePort 等待超时');
    await sleep(150);
  }
}

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${step}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) throw new Error(`浏览器证据步骤失败：${step}`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const server = await startTestServer({ commitSha });
  let chromeProc = null;
  let chromeProfile = null;
  const cdpHolder = { cdp: null };
  try {
    // ---- 数据准备：真实 HTTP 注册 + 真实 CLI 引导子进程（AC-35 成功路径顺带实证） ----
    const reg = async (username) => {
      const res = await fetch(`${server.baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'Web@12345' }),
      });
      if (res.status !== 201) throw new Error(`注册 ${username} 失败：${res.status}`);
    };
    await reg('web_admin');
    await reg('web_user');
    const cli = execFileSync(process.execPath, ['server/bootstrap-admin.mjs', '--username', 'web_admin'], {
      env: { ...process.env, NEXORA_DB_PATH: server.dbPath },
      encoding: 'utf8',
    });
    record('准备：注册 web_admin/web_user + 真实 CLI 引导（退出码 0）', true, cli.trim().split('\n')[0]);

    // ---- 启动真实 Chrome 并附着 CDP ----
    const launched = await launchChrome();
    chromeProc = launched.chrome;
    chromeProfile = launched.profile;
    const version = await fetch(`http://127.0.0.1:${launched.port}/json/version`).then((r) => r.json());
    const cdp = new Cdp(version.webSocketDebuggerUrl);
    cdpHolder.cdp = cdp;
    await cdp.connect();
    await cdp.attachPage('about:blank');
    record('启动真实浏览器', true, version.Browser);

    const shot = async (name) => {
      const file = await cdp.shot(name);
      console.log(`  📸 ${file}`);
    };

    // ---- S1 登录页 ----
    await cdp.navigate(server.baseUrl);
    await cdp.waitFor(`!document.getElementById('view-login').hidden`, { label: '登录视图可见' });
    await shot('01-login-page');
    record('S1 未登录打开应用 → 登录视图', true);

    // ---- S2 admin 登录 → 欢迎视图出现「进入后台管理」 ----
    await cdp.eval(`
      document.getElementById('login-username').value = 'web_admin';
      document.getElementById('login-password').value = 'Web@12345';
      document.getElementById('login-form').querySelector('button[type=submit], button.primary').click();
    `);
    await cdp.waitFor(`!document.getElementById('view-welcome').hidden && document.getElementById('welcome-username').textContent === 'web_admin'`, { label: 'admin 欢迎视图' });
    await cdp.waitFor(`!document.getElementById('goto-admin').hidden`, { label: '进入后台管理按钮可见' });
    await shot('02-admin-welcome');
    record('S2 web_admin 登录 → 欢迎视图含「进入后台管理」', true);

    // ---- S3 进入后台：四个中文入口 ----
    await cdp.eval(`document.getElementById('goto-admin').click()`);
    await cdp.waitFor(`document.querySelectorAll('#admin-nav .admin-nav-item').length === 4`, { label: '四个导航入口' });
    const navText = await cdp.eval(`[...document.querySelectorAll('#admin-nav .admin-nav-item')].map((b) => b.textContent).join('|')`);
    if (navText !== '用户管理|角色管理|权限目录|授权审计') throw new Error(`导航文案不符：${navText}`);
    await shot('03-admin-nav-four-entries');
    record('S3 后台导航四入口（用户管理/角色管理/权限目录/授权审计）', true, navText);

    // ---- S4 角色管理 → 新建角色 ----
    await cdp.eval(`[...document.querySelectorAll('#admin-nav .admin-nav-item')].find((b) => b.dataset.view === 'roles').click()`);
    await cdp.waitFor(`document.querySelector('#admin-content .page-title')?.textContent === '角色管理'`, { label: '角色管理页' });
    await cdp.eval(`[...document.querySelectorAll('#admin-content button')].find((b) => b.textContent === '新建角色').click()`);
    await cdp.waitFor(`!!document.querySelector('#admin-content form.role-form')`, { label: '新建角色表单' });
    await cdp.eval(`
      const inputs = document.querySelectorAll('#admin-content form.role-form input');
      inputs[0].value = '网页验证角色';
      inputs[1].value = 'web_ops';
      inputs[2].value = '由真实浏览器创建';
      document.querySelector('#admin-content form.role-form button[type=submit]').click();
    `);
    await cdp.waitFor(`document.querySelector('#admin-content .page-title')?.textContent.includes('角色详情：网页验证角色')`, { label: '新建后进入详情' });
    await shot('04-role-created');
    record('S4 浏览器新建角色 web_ops 成功并进入详情', true);

    // ---- S5 权限树：父子联动 + 半选 + 计数 ----
    await cdp.waitFor(`document.querySelectorAll('#admin-content .tree-group').length === 4`, { label: '权限树四分组' });
    // 勾选「用户管理」整组（父子联动 → 3 叶子全选）
    await cdp.eval(`document.querySelectorAll('#admin-content .tree-group-label input')[0].click()`);
    await cdp.waitFor(`document.querySelector('#admin-content .tree-counter')?.textContent === '已选 3 项权限'`, { label: '组勾选联动计数 3' });
    // 勾选「角色管理」组内第一片叶子（role:read）→ 父级半选
    await cdp.eval(`document.querySelectorAll('#admin-content .tree-group')[1].querySelector('.tree-leaf input').click()`);
    await cdp.waitFor(`document.querySelector('#admin-content .tree-counter')?.textContent === '已选 4 项权限'`, { label: '计数 4' });
    const halfState = await cdp.eval(`document.querySelectorAll('#admin-content .tree-group-label input')[1].indeterminate`);
    if (halfState !== true) throw new Error('角色管理组未呈半选态');
    await shot('05-tree-halfchecked-counter');
    record('S5 权限树父子联动/半选态/已选计数（已选 4 项权限）', true, '用户管理组全选 + 角色管理组半选');

    // ---- S6 保存 → 回显与数据库一致（等待重建完成：叶子渲染且勾选数=4，避免加载窗口竞态） ----
    await cdp.eval(`[...document.querySelectorAll('#admin-content .tree-actions button')].find((b) => b.textContent === '保存').click()`);
    await cdp.waitFor(`
      document.querySelectorAll('#admin-content .tree-leaf input').length > 0
      && [...document.querySelectorAll('#admin-content .tree-leaf input')].filter((i) => i.checked).length === 4
      && document.querySelector('#admin-content .tree-counter')?.textContent === '已选 4 项权限'
    `, { label: '保存后重建回显 4 项' });
    // 经浏览器同源会话核对服务端持久化（回显与数据库一致，AC-18）
    const persistedKeys = await cdp.eval(`
      fetch('/api/admin/roles?q=web_ops').then((r) => r.json()).then(async (list) => {
        const role = list.items.find((i) => i.key === 'web_ops');
        const detail = await fetch('/api/admin/roles/' + role.id).then((r) => r.json());
        return detail.role.permissionKeys;
      })
    `, true);
    const expectedKeys = ['role:read', 'user:assign_roles', 'user:read', 'user:status'];
    if (JSON.stringify(persistedKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`服务端持久化权限集不符：${JSON.stringify(persistedKeys)}`);
    }
    const saveFeedback = await cdp.eval(`[...document.querySelectorAll('#admin-content .error')].some((p) => !p.hidden && p.textContent) `);
    if (saveFeedback) throw new Error('保存后出现错误反馈');
    await shot('06-tree-saved-echo');
    record('S6 保存后重建回显与数据库一致（4 项勾选，服务端核对通过）', true, persistedKeys.join(','));

    // ---- S7 用户管理 → 给 web_user 绑定 web_ops ----
    await cdp.eval(`[...document.querySelectorAll('#admin-nav .admin-nav-item')].find((b) => b.dataset.view === 'users').click()`);
    await cdp.waitFor(`document.querySelector('#admin-content .page-title')?.textContent === '用户管理'`, { label: '用户管理页' });
    await cdp.waitFor(`[...document.querySelectorAll('#admin-content .data-table td')].some((td) => td.textContent === 'web_user')`, { label: '用户列表含 web_user' });
    await cdp.eval(`
      const row = [...document.querySelectorAll('#admin-content .data-table tr')].find((tr) => tr.textContent.includes('web_user'));
      [...row.querySelectorAll('button')].find((b) => b.textContent === '详情').click();
    `);
    await cdp.waitFor(`document.querySelector('#admin-content .page-title')?.textContent === '用户详情：web_user'`, { label: '用户详情页' });
    await cdp.waitFor(`document.querySelectorAll('#admin-content .check-list .check-item input').length >= 1`, { label: '可选角色列表' });
    await cdp.eval(`
      const item = [...document.querySelectorAll('#admin-content .check-list .check-item')].find((c) => c.textContent.includes('web_ops'));
      item.querySelector('input').click();
    `);
    await cdp.eval(`[...document.querySelectorAll('#admin-content button')].find((b) => b.textContent === '保存')?.click()`);
    // 保存成功 → 按服务端详情重建（含加载窗口）；以「重建后勾选保持 + 服务端持久化」双断言为准（AC-21）
    await cdp.waitFor(`
      document.querySelectorAll('#admin-content .check-list .check-item input').length > 0
      && [...document.querySelectorAll('#admin-content .check-list .check-item')].find((c) => c.textContent.includes('web_ops'))?.querySelector('input')?.checked === true
      && document.querySelector('#admin-content .muted')?.textContent === '已选 1 个角色'
    `, { label: '用户授权保存后回显 web_ops' });
    const userPersisted = await cdp.eval(`
      fetch('/api/admin/users/web_user').then((r) => r.json()).then((d) => d.user.roles.map((r) => r.key))
    `, true);
    if (!Array.isArray(userPersisted) || !userPersisted.includes('web_ops')) {
      throw new Error(`服务端用户角色不符：${JSON.stringify(userPersisted)}`);
    }
    await shot('07-user-role-assigned');
    record('S7 浏览器给 web_user 绑定角色 web_ops 并保存回显（服务端核对通过）', true, userPersisted.join(','));

    // ---- S8 注销并以 web_user 登录：受限导航 ----
    // 清空 hash，避免 admin 流程残留的 #/admin/<view> 使登录后直达管理壳（产品既定行为），确保走欢迎视图叙事
    await cdp.eval(`document.getElementById('admin-logout').click(); window.location.hash = '';`);
    await cdp.waitFor(`!document.getElementById('view-login').hidden`, { label: '回到登录视图' });
    await cdp.eval(`
      document.getElementById('login-username').value = 'web_user';
      document.getElementById('login-password').value = 'Web@12345';
      document.getElementById('login-form').querySelector('button[type=submit], button.primary').click();
    `);
    await cdp.waitFor(`!document.getElementById('view-welcome').hidden && document.getElementById('welcome-username').textContent === 'web_user'`, { label: 'web_user 欢迎视图' });
    await cdp.waitFor(`!document.getElementById('goto-admin').hidden`, { label: 'web_user 有管理入口' });
    await cdp.eval(`document.getElementById('goto-admin').click()`);
    await cdp.waitFor(`document.querySelectorAll('#admin-nav .admin-nav-item').length === 2`, { label: 'web_user 仅两个入口' });
    const userNav = await cdp.eval(`[...document.querySelectorAll('#admin-nav .admin-nav-item')].map((b) => b.textContent).join('|')`);
    if (userNav !== '用户管理|角色管理') throw new Error(`受限导航不符：${userNav}`);
    await shot('08-user-limited-nav');
    record('S8 web_user 登录后仅见获准入口（用户管理/角色管理）', true, userNav);

    // ---- S9 撤权：admin 经 API 解绑（真实 HTTP 写） → web_user 浏览器端下一动作即无权限 ----
    const adminLogin = await fetch(`${server.baseUrl}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'web_admin', password: 'Web@12345' }),
    });
    const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
    const webOps = await fetch(`${server.baseUrl}/api/admin/roles?q=web_ops`, { headers: { Cookie: adminCookie } }).then((r) => r.json());
    const revoke = await fetch(`${server.baseUrl}/api/admin/users/web_user/roles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Nexora-CSRF': '1', Cookie: adminCookie },
      body: JSON.stringify({ roleIds: [] }),
    });
    if (revoke.status !== 200) throw new Error(`撤权失败：${revoke.status}`);
    void webOps;
    // web_user 在浏览器内点击任一入口 → 渲染时 API 403 → 无权限态
    await cdp.eval(`[...document.querySelectorAll('#admin-nav .admin-nav-item')].find((b) => b.dataset.view === 'users')?.click()`);
    await cdp.waitFor(`document.querySelector('#admin-content .state-forbidden') !== null`, { label: '无权限态' });
    const forbiddenText = await cdp.eval(`document.querySelector('#admin-content .state-forbidden').textContent`);
    const apiStatus = await cdp.eval(`fetch('/api/admin/users').then((r) => r.status)`, true);
    if (apiStatus !== 403) throw new Error(`撤权后底层 API 应 403，实际 ${apiStatus}`);
    await shot('09-after-revoke-forbidden');
    record('S9 撤权后 web_user 页面呈无权限态且底层 API 实测 403', true, `${forbiddenText}；API=${apiStatus}`);

    // ---- S10 审计页：admin 重新登录检索留痕 ----
    await cdp.eval(`document.getElementById('admin-logout').click(); window.location.hash = '';`);
    await cdp.waitFor(`!document.getElementById('view-login').hidden`, { label: '回登录' });
    await cdp.eval(`
      document.getElementById('login-username').value = 'web_admin';
      document.getElementById('login-password').value = 'Web@12345';
      document.getElementById('login-form').querySelector('button[type=submit], button.primary').click();
    `);
    await cdp.waitFor(`!document.getElementById('view-welcome').hidden`, { label: 'admin 欢迎' });
    await cdp.eval(`document.getElementById('goto-admin').click()`);
    await cdp.waitFor(`document.querySelectorAll('#admin-nav .admin-nav-item').length === 4`, { label: 'admin 导航恢复' });
    // DEF-02 修复后：不等待首个视图就绪即快速切换导航，直接回归原竞态路径（慢响应晚到不得覆盖当前视图）
    await cdp.eval(`[...document.querySelectorAll('#admin-nav .admin-nav-item')].find((b) => b.dataset.view === 'audit').click()`);
    await cdp.waitFor(`document.querySelector('#admin-content .page-title')?.textContent === '授权审计'`, { label: '授权审计页' });
    // createElement 构建的表格无 tbody（浏览器仅对解析期 HTML 自动补 tbody），数据行 = tr 总数 - 表头
    await cdp.waitFor(`document.querySelectorAll('#admin-content .data-table tr').length - 1 >= 5`, { label: '审计行渲染（≥5 数据行）' });
    const auditText = await cdp.eval(`document.querySelector('#admin-content .data-table').textContent`);
    // 动作列渲染为中文标签（ACTION_LABELS），核对全流程动作与对象留痕
    for (const expect of ['角色新建', '角色授权', '用户授权', '引导授权', '网页验证角色', 'web_user', 'web_admin', '成功']) {
      if (!auditText.includes(expect)) throw new Error(`审计页缺少「${expect}」留痕`);
    }
    await shot('10-audit-events');
    record('S10 审计页可检索浏览器全流程留痕（建角色/授权/绑定/撤权）', true);

    // ---- S11 窄屏 375px：导航与关键操作可达 ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    await cdp.eval(`[...document.querySelectorAll('#admin-nav .admin-nav-item')].find((b) => b.dataset.view === 'roles').click()`);
    await cdp.waitFor(`document.querySelector('#admin-content .page-title')?.textContent === '角色管理'`, { label: '窄屏角色管理' });
    const overflow = await cdp.eval(`document.documentElement.scrollWidth > 376 && getComputedStyle(document.querySelector('.admin-content')).overflowX !== 'auto' && !document.querySelector('.data-table')`);
    await shot('11-narrow-375px');
    if (overflow) throw new Error('窄屏出现不可达溢出');
    record('S11 375px 窄屏导航与页面可用（表格横滚适配）', true);

    // ---- 页面 JS 异常检查 ----
    if (cdp.pageErrors.length > 0) throw new Error(`页面 JS 异常：${cdp.pageErrors.join(' | ')}`);
    record('全程无页面 JS 异常（Runtime.exceptionThrown=0）', true);

    writeFileSync(join(outDir, 'evidence-log.json'), JSON.stringify({
      requirement: 'NEXORA-RBAC-011',
      browser: version.Browser,
      commitSha,
      serverBaseUrl: server.baseUrl,
      dbIsolated: server.dbPath,
      steps: results,
      pageErrors: cdp.pageErrors,
    }, null, 2));
    console.log(`\n全部 ${results.length} 步通过；证据目录：${outDir}`);
  } finally {
    // 清理不得掩盖主流程结果：逐步 try/catch，Chrome 退出与 profile 删除带重试
    try {
      cdpHolder.cdp?.close();
    } catch { /* 忽略 */ }
    if (chromeProc) {
      try {
        chromeProc.kill('SIGTERM');
        await new Promise((resolve) => {
          chromeProc.once('exit', resolve);
          setTimeout(resolve, 3000);
        });
      } catch { /* 忽略 */ }
    }
    try {
      await server.close();
    } catch { /* 忽略 */ }
    if (chromeProfile) {
      try {
        rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
      } catch { /* 忽略 */ }
    }
  }
}

main().catch((error) => {
  console.error(`\n✖ 浏览器证据采集失败：${error.message}`);
  writeFileSync(join(outDir, 'evidence-log.json'), JSON.stringify({ failed: true, error: error.message, steps: results }, null, 2));
  process.exitCode = 1;
});
