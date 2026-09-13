/**
 * API 路由（架构 §3 契约，字段名/状态码/错误格式不得偏离）：
 * register 201/400/409（不建会话、不下发 Cookie）；login 200+Set-Cookie / 400 / 401 通用；
 * logout 一律 200 + Max-Age=0 清 Cookie；me/resource 走 requireSession；health 返回 version。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorBody } from './http-server.mjs';
import { validateCredentials } from './validation.mjs';

export const SESSION_COOKIE = 'nexora_session';
const COOKIE_MAX_AGE_SECONDS = 86_400; // 与服务端 24h 绝对过期对齐（AD-05）

/** 构造会话 Cookie（HttpOnly + SameSite=Lax + Path=/ + Max-Age=86400；loopback 开发模式不设 Secure）。 */
export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

/** 构造清除 Cookie（注销幂等：始终下发，REQ-003）。 */
export function clearCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * 解析运行版本 commit SHA（AD-07）：
 * APP_COMMIT_SHA 环境变量（config.commitSha）→ 仓库根 VERSION 文件首行 → "unknown"。
 * 只读该命名变量与 VERSION 文件，不泛化读取任意环境变量。
 * @param {{commitSha: string|null}} config
 * @param {string} repoRoot
 */
export async function resolveVersion(config, repoRoot) {
  if (config.commitSha) return config.commitSha;
  try {
    const content = await readFile(join(repoRoot, 'VERSION'), 'utf8');
    const firstLine = content.split('\n')[0].trim();
    if (firstLine) return firstLine;
  } catch {
    /* VERSION 不存在或不可读 → unknown */
  }
  return 'unknown';
}

/**
 * 构建五个 API 端点路由表。
 * @param {{authService: object, config: object, repoRoot: string}} deps
 */
export function buildRoutes({ authService, config, repoRoot }) {
  /** 受保护守卫：解析 Cookie → 领域判定 → 失败统一 401（架构 §4）。 */
  function requireSession(ctx) {
    const session = authService.resolveSession(ctx.cookies[SESSION_COOKIE]);
    if (!session) {
      return { status: 401, body: errorBody('unauthorized', '未认证或会话已失效') };
    }
    ctx.session = session;
    return null;
  }

  return [
    {
      method: 'POST',
      path: '/api/register',
      handler: (ctx) => {
        const checked = validateCredentials(ctx.body);
        if (!checked.ok) {
          return { status: 400, body: errorBody('invalid_params', '参数不合法', checked.fields) };
        }
        const result = authService.register(checked.value);
        if (!result.ok) {
          return { status: result.status, body: errorBody(result.code, result.message) };
        }
        // Q2：注册成功不创建会话、不下发 Cookie、响应不含密码/哈希
        return { status: 201, body: { user: { username: result.user.username } } };
      },
    },
    {
      method: 'POST',
      path: '/api/login',
      handler: (ctx) => {
        const checked = validateCredentials(ctx.body);
        if (!checked.ok) {
          return { status: 400, body: errorBody('invalid_params', '参数不合法', checked.fields) };
        }
        const result = authService.login(checked.value);
        if (!result.ok) {
          return { status: result.status, body: errorBody(result.code, result.message) };
        }
        return {
          status: 200,
          body: { user: { username: result.user.username }, session: { expiresAt: result.expiresAt } },
          headers: { 'Set-Cookie': sessionCookieHeader(result.token) },
        };
      },
    },
    {
      method: 'POST',
      path: '/api/logout',
      handler: (ctx) => {
        // 幂等：有效/已注销/过期/伪造/无 Cookie 均返回相同成功语义（AC-06）
        authService.logout(ctx.cookies[SESSION_COOKIE]);
        return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': clearCookieHeader() } };
      },
    },
    {
      method: 'GET',
      path: '/api/me',
      handler: (ctx) => {
        const denied = requireSession(ctx);
        if (denied) return denied;
        return {
          status: 200,
          body: { user: { username: ctx.session.user.username }, session: { expiresAt: ctx.session.expiresAt } },
        };
      },
    },
    {
      method: 'GET',
      path: '/api/resource',
      handler: (ctx) => {
        const denied = requireSession(ctx);
        if (denied) return denied;
        return {
          status: 200,
          body: { resource: { title: '云枢后台示例资源', owner: ctx.session.user.username } },
        };
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler: async () => {
        const version = await resolveVersion(config, repoRoot);
        return { status: 200, body: { status: 'ok', version } };
      },
    },
  ];
}
