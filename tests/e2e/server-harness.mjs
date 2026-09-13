/**
 * e2e 线束（架构 §8）：临时目录 DB、随机空闲端口、可注入 TTL/时钟/SHA，起真实 HTTP 服务。
 * 所有用例必须打真实服务；fetch 不自动携带 Cookie，jar 手动管理 Set-Cookie 以模拟浏览器。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, startApp } from '../../server/index.mjs';
import { systemClock } from '../../server/clock.mjs';

/**
 * 启动一台真实 HTTP 服务。
 * @param {{sessionTtlMs?: number, commitSha?: string|null, clock?: object}} [options]
 */
export async function startTestServer(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-e2e-'));
  const logLines = [];
  const config = {
    host: '127.0.0.1',
    port: 0, // 随机空闲端口
    dbPath: join(dir, 'e2e.db'),
    sessionTtlMs: options.sessionTtlMs ?? 86_400_000,
    commitSha: options.commitSha ?? null,
  };
  const logger = {
    request: (method, path, status, code) => logLines.push(`request method=${method} path=${path} status=${status} code=${code}`),
    info: (message) => logLines.push(`info ${message}`),
    error: (message, stack) => logLines.push(`error ${message} ${stack ?? ''}`),
  };
  const app = createApp({ config, clock: options.clock ?? systemClock(), logger });
  const handle = await startApp(app);
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    app,
    logLines,
    dbPath: config.dbPath,
    /** 带 Cookie jar 的最小客户端。 */
    client: () => createClient(baseUrl),
    close: async () => {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 手动 Cookie jar 客户端（fetch 不持久化 Cookie，逐请求显式管理以模拟浏览器行为）。
 */
export function createClient(baseUrl) {
  let cookie = null;
  return {
    get cookie() {
      return cookie;
    },
    setCookie(value) {
      cookie = value;
    },
    /**
     * 发起请求；返回 { status, body, setCookie, headers }。
     * body 为解析后的 JSON 或 null。
     */
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const finalHeaders = { ...headers };
      if (body !== undefined) finalHeaders['Content-Type'] = finalHeaders['Content-Type'] ?? 'application/json';
      if (cookie) finalHeaders.Cookie = cookie;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: finalHeaders,
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        const pair = setCookie.split(';')[0];
        cookie = pair.startsWith('nexora_session=') && pair !== 'nexora_session=' ? pair : null;
      }
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed, rawBody: text, setCookie, headers: response.headers };
    },
  };
}
