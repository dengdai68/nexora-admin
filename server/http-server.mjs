/**
 * 内置 HTTP 层（架构 §3 通用约定 / DEV-06）：
 * 路由表（方法+精确路径）、JSON 解析（仅 application/json，>16KB → 413，解析失败 → 400）、
 * Cookie 解析与 Set-Cookie 工具、统一错误边界（500 通用体）、静态资源白名单防穿越、404/405。
 * 本层不含领域规则；日志只记录方法/路径/状态码/稳定错误码。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 16 * 1024; // 16 KB
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** 稳定错误响应体构造。 */
export function errorBody(code, message, fields) {
  const error = { code, message };
  if (fields) error.fields = fields;
  return { error };
}

/**
 * 解析请求 Cookie 头（只返回值，不记录日志）。
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

/**
 * 读取并解析 JSON 请求体。
 * @throws {{httpError:{status:number, body:object}}} 413/415/400
 */
async function readJsonBody(req) {
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw { httpError: { status: 415, body: errorBody('unsupported_media_type', '仅接受 application/json 请求体') } };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw { httpError: { status: 413, body: errorBody('payload_too_large', '请求体超过 16KB 上限') } };
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw { httpError: { status: 400, body: errorBody('invalid_json', '请求体不是合法 JSON') } };
  }
}

/**
 * 创建 HTTP 服务。
 * @param {{
 *   routes: Array<{method:string, path:string, handler:(ctx:object)=>Promise<object>|object}>,
 *   staticDir: string,
 *   staticFiles: Record<string, string>,
 *   logger: {request:Function, error:Function, info:Function},
 * }} options
 * routes handler 约定：返回 { status, body, headers? } 或 { error } 交由错误边界。
 * ctx = { req, body, cookies, params:{} }
 */
export function createHttpServer({ routes, staticDir, staticFiles, logger }) {
  const routeTable = new Map();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    routeTable.set(key, route.handler);
  }

  const server = createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    try {
      // API 路由
      if (path.startsWith('/api/')) {
        const handler = routeTable.get(`${method} ${path}`);
        if (!handler) {
          const samePathMethods = routes.filter((r) => r.path === path).map((r) => r.method);
          if (samePathMethods.length > 0) {
            return sendJson(res, 405, errorBody('method_not_allowed', '方法不允许'), logger, method, path, 'method_not_allowed', {
              Allow: samePathMethods.join(', '),
            });
          }
          return sendJson(res, 404, errorBody('not_found', '接口不存在'), logger, method, path, 'not_found');
        }
        const ctx = { req, cookies: parseCookies(req.headers.cookie), params: {} };
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
          ctx.body = await readJsonBody(req);
        }
        const result = await handler(ctx);
        return sendJson(res, result.status, result.body, logger, method, path, result.body?.error?.code ?? '-', result.headers);
      }

      // 静态资源（白名单 + 归一化防穿越）
      if (method === 'GET' || method === 'HEAD') {
        return await serveStatic(req, res, path, staticDir, staticFiles, logger, method);
      }
      return sendJson(res, 405, errorBody('method_not_allowed', '方法不允许'), logger, method, path, 'method_not_allowed');
    } catch (err) {
      if (err && err.httpError) {
        return sendJson(res, err.httpError.status, err.httpError.body, logger, method, path, err.httpError.body.error.code);
      }
      logger.error(`internal_error method=${method} path=${path}`, err && err.stack);
      return sendJson(res, 500, errorBody('internal_error', '服务内部错误'), logger, method, path, 'internal_error');
    }
  });

  return server;
}

function sendJson(res, status, body, logger, method, path, code, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
  logger.request(method, path, status, code);
}

async function serveStatic(req, res, path, staticDir, staticFiles, logger, method) {
  const mapped = staticFiles[path];
  if (!mapped) {
    return sendJson(res, 404, errorBody('not_found', '资源不存在'), logger, method, path, 'not_found');
  }
  const resolved = normalize(join(staticDir, mapped));
  if (!resolved.startsWith(normalize(staticDir))) {
    return sendJson(res, 404, errorBody('not_found', '资源不存在'), logger, method, path, 'not_found');
  }
  try {
    const content = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': STATIC_MIME[extname(mapped)] || 'application/octet-stream' });
    res.end(method === 'HEAD' ? undefined : content);
    logger.request(method, path, 200, '-');
  } catch {
    return sendJson(res, 404, errorBody('not_found', '资源不存在'), logger, method, path, 'not_found');
  }
}
