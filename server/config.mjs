/**
 * 配置解析（AD-11）：仅读取白名单 5 个环境变量，非法值快速失败。
 * 白名单：NEXORA_HOST / NEXORA_PORT / NEXORA_DB_PATH / NEXORA_SESSION_TTL_MS / APP_COMMIT_SHA
 * 除此之外不读取任何环境变量。
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4322;
const DEFAULT_DB_PATH = 'data/nexora.db';
const DEFAULT_SESSION_TTL_MS = 86_400_000; // 24h 绝对过期（Q1）
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * 解析正整数配置项；非法时抛出带字段名的可读错误。
 * @param {string} name 环境变量名（用于错误信息）
 * @param {string|undefined} raw 原始字符串
 * @param {number} fallback 缺省值
 * @param {{min:number,max:number}} range 合法区间
 * @returns {number}
 */
function parseIntOption(name, raw, fallback, range) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`配置错误：${name} 必须为正整数，收到 "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    throw new Error(`配置错误：${name} 必须在 ${range.min}–${range.max} 之间，收到 "${raw}"`);
  }
  return value;
}

/**
 * 从环境构造配置对象。
 * @param {NodeJS.ProcessEnv} [env] 可注入的环境（测试用）
 * @returns {{host:string, port:number, dbPath:string, sessionTtlMs:number, commitSha:string|null}}
 */
export function loadConfig(env = process.env) {
  const host = env.NEXORA_HOST === undefined || env.NEXORA_HOST === '' ? DEFAULT_HOST : env.NEXORA_HOST;
  const port = parseIntOption('NEXORA_PORT', env.NEXORA_PORT, DEFAULT_PORT, { min: MIN_PORT, max: MAX_PORT });
  const dbPath = env.NEXORA_DB_PATH === undefined || env.NEXORA_DB_PATH === '' ? DEFAULT_DB_PATH : env.NEXORA_DB_PATH;
  const sessionTtlMs = parseIntOption('NEXORA_SESSION_TTL_MS', env.NEXORA_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  const commitSha = env.APP_COMMIT_SHA === undefined || env.APP_COMMIT_SHA === '' ? null : env.APP_COMMIT_SHA;
  return { host, port, dbPath, sessionTtlMs, commitSha };
}

export const CONFIG_DEFAULTS = Object.freeze({
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  dbPath: DEFAULT_DB_PATH,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
});
