/**
 * DEF-02 确定性复现（NEXORA-RBAC-011 / 测试节点）：
 * 管理壳视图切换无并发防护——进入后台默认渲染「用户管理」并发起慢请求期间，快速点击「授权审计」，
 * 若用户列表响应后返回，会覆盖审计页内容，造成 hash/导航高亮与内容不一致。
 * 复现手法：CDP Fetch 域拦截 /api/admin/users 并挂起，切换至审计页渲染完成后放行挂起响应；
 * 断言：放行后内容区被覆盖为「用户管理」而 location.hash 仍为 #/admin/audit（状态不一致即复现）。
 * 用法：node tests/browser/def-02-view-race-repro.mjs（零第三方依赖，需本机 Chrome）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startTestServer } from '../e2e/server-harness.mjs';
import { bootstrapAdmin } from '../../server/bootstrap-admin.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = process.argv[2] ?? join(process.cwd(), 'docs/testing/evidence');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  mkdirSync(outDir, { recursive: true });
  const server = await startTestServer({ commitSha: 'def02-repro' });
  const profile = mkdtempSync(join(tmpdir(), 'nexora-def02-'));
  let chrome;
  try {
    // 准备：注册 + 引导超管（直接作用于线束临时库）
    await fetch(`${server.baseUrl}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'def02_admin', password: 'Web@12345' }),
    });
    bootstrapAdmin(server.app.db, server.app.auditService, 'def02_admin', Date.now());

    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let port;
    for (;;) {
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); break; } catch { await sleep(150); }
    }
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let nextId = 0;
    const pending = new Map();
    const held = []; // 被挂起的 /api/admin/users 请求
    let sid = null; // 页面 flat session（Fetch 命令必须同会话）
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, request } = msg.params;
        if (request.url.includes('/api/admin/users')) {
          held.push(requestId); // 挂起用户列表请求，稍后放行
        } else {
          ws.send(JSON.stringify({ id: ++nextId, method: 'Fetch.continueRequest', params: { requestId }, sessionId: msg.sessionId ?? sid }));
        }
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); });
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    sid = sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/admin/*' }] }, sessionId);
    const ev = async (expression, awaitPromise = false) => {
      const msg = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
      if (msg.result.exceptionDetails) throw new Error(`求值异常：${msg.result.exceptionDetails.text}`);
      return msg.result.result?.value;
    };

    await send('Page.navigate', { url: server.baseUrl }, sessionId);
    await sleep(1000);
    await ev(`document.getElementById('login-username').value='def02_admin';document.getElementById('login-password').value='Web@12345';document.querySelector('#login-form button.primary').click();`);
    for (let i = 0; i < 80 && !(await ev(`!document.getElementById('view-welcome').hidden`)); i += 1) await sleep(120);

    // 进入后台：用户管理渲染开始（其 fetch 被 Fetch 域挂起），立即切换到授权审计
    await ev(`document.getElementById('goto-admin').click()`);
    for (let i = 0; i < 40 && held.length === 0; i += 1) await sleep(100); // 确认 users 请求已挂起
    if (held.length === 0) throw new Error('未能挂起 /api/admin/users 请求');
    await ev(`[...document.querySelectorAll('#admin-nav .admin-nav-item')].find((b) => b.dataset.view === 'audit').click()`);
    // 等待审计页渲染完成（其请求未被挂起）
    let ok = false;
    for (let i = 0; i < 100; i += 1) {
      if ((await ev(`document.querySelector('#admin-content .page-title')?.textContent`)) === '授权审计') { ok = true; break; }
      await sleep(120);
    }
    if (!ok) throw new Error('审计页未如期渲染');
    console.log('审计页已渲染，hash =', await ev('location.hash'));
    // 放行被挂起的用户列表慢响应（continueRequest 让真实 200 响应晚到，覆盖当前视图）
    for (const requestId of held.splice(0)) {
      ws.send(JSON.stringify({ id: ++nextId, method: 'Fetch.continueRequest', params: { requestId }, sessionId: sid }));
    }
    await sleep(1500);
    const finalTitle = await ev(`document.querySelector('#admin-content .page-title')?.textContent`);
    const finalHash = await ev('location.hash');
    const activeNav = await ev(`document.querySelector('#admin-nav .admin-nav-item.active')?.dataset.view ?? '-'`);
    console.log(`放行后：page-title=${finalTitle}，hash=${finalHash}，导航高亮=${activeNav}`);
    const { result: shot } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    // 最新一次运行的截图独立命名，不覆盖测试节点留存的原始缺陷证据 def-02-view-race.png
    writeFileSync(join(outDir, 'def-02-view-race-run.png'), Buffer.from(shot.data, 'base64'));
    const reproduced = finalTitle === '用户管理' && finalHash === '#/admin/audit';
    console.log(reproduced ? '✔ DEF-02 复现成立：内容被旧响应覆盖，与 hash/导航不一致' : '✖ 未复现');
    ws.close();
    process.exitCode = reproduced ? 0 : 1;
  } finally {
    if (chrome) chrome.kill('SIGTERM');
    await sleep(500);
    await server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  }
}

main().catch((error) => {
  console.error('复现脚本异常：', error.message);
  process.exitCode = 2;
});
