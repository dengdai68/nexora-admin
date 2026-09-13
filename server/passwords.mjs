/**
 * 密码原语（REQ-012）：scrypt(N=16384, r=8, p=1, keylen=64) + 每用户 16 字节随机盐。
 * 存储格式：scrypt:N:r:p:saltB64:hashB64（自带参数版本，支持未来升级）。
 * 校验使用 timingSafeEqual，畸形存储串返回 false 而非抛异常。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
const FORMAT_PREFIX = 'scrypt';

/**
 * 生成带盐哈希存储串。
 * @param {string} password 明文密码（调用方负责边界校验）
 * @returns {string} scrypt:N:r:p:saltB64:hashB64
 */
export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [FORMAT_PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), derived.toString('base64')].join(
    ':',
  );
}

/**
 * 校验明文密码是否匹配存储串。
 * @param {string} password
 * @param {string} stored 存储串；任何畸形都返回 false
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  const derived = scryptSync(password, parsed.salt, KEY_LEN, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
  });
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

/**
 * 解析存储串；畸形返回 null。
 * @returns {{n:number, r:number, p:number, salt:Buffer, hash:Buffer} | null}
 */
function parseStored(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== FORMAT_PREFIX) return null;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  let salt;
  let hash;
  try {
    salt = Buffer.from(parts[4], 'base64');
    hash = Buffer.from(parts[5], 'base64');
  } catch {
    return null;
  }
  if (salt.length === 0 || hash.length === 0) return null;
  return { n, r, p, salt, hash };
}

/**
 * 内置 dummy 存储串：用户不存在时执行同等 scrypt 校验以缩小时间侧信道（架构 §3.2）。
 * 由 hashPassword('dummy-password-for-timing') 预生成一次（模块加载时），参数与真实一致。
 */
let dummyHash = null;
export function getDummyHash() {
  if (dummyHash === null) dummyHash = hashPassword('dummy-password-not-a-real-credential');
  return dummyHash;
}
