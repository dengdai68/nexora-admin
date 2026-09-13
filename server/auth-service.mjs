/**
 * 领域服务（架构 §5）：register / login / logout / resolveSession / cleanupExpiredSessions。
 * 不感知 HTTP；所有时间判定走注入时钟；会话有效期落库后不变（24h 绝对过期，Q1）。
 */
import {
  deleteExpiredSessions,
  findSessionByTokenHash,
  findUserById,
  findUserByUsername,
  insertSession,
  insertUser,
  revokeSessionByTokenHash,
} from './db.mjs';
import { getDummyHash, hashPassword, verifyPassword } from './passwords.mjs';
import { generateToken, hashToken } from './tokens.mjs';

/** 通用凭据错误（防枚举，用户不存在与密码错误完全一致，REQ-002）。 */
export const INVALID_CREDENTIALS = Object.freeze({
  ok: false,
  status: 401,
  code: 'invalid_credentials',
  message: '用户名或密码错误',
});

/**
 * 创建领域服务实例。
 * @param {{db: import('node:sqlite').DatabaseSync, clock: {now: () => number}, sessionTtlMs: number}} deps
 */
export function createAuthService({ db, clock, sessionTtlMs }) {
  /**
   * 注册（Q2：不创建会话）。
   * @returns {{ok:true, user:{username:string}} | {ok:false, status:number, code:string, message:string}}
   */
  function register({ username, password }) {
    if (findUserByUsername(db, username)) {
      return { ok: false, status: 409, code: 'username_taken', message: '用户名已被占用' };
    }
    insertUser(db, { username, passwordHash: hashPassword(password), createdAt: clock.now() });
    return { ok: true, user: { username } };
  }

  /**
   * 登录：格式已合法；凭据错误统一 INVALID_CREDENTIALS；
   * 用户不存在时对 dummy 哈希执行同等 scrypt 校验以对齐时延。
   * 被禁用用户返回与密码错误逐字节一致的 401（AD-05 防枚举），不创建会话。
   * @returns {{ok:true, user:{username:string}, token:string, expiresAt:number} | INVALID_CREDENTIALS}
   */
  function login({ username, password }) {
    const user = findUserByUsername(db, username);
    const storedHash = user ? user.passwordHash : getDummyHash();
    const verified = verifyPassword(password, storedHash);
    if (!user || !verified) return INVALID_CREDENTIALS;
    if (user.status !== 'active') return INVALID_CREDENTIALS;
    const token = generateToken();
    const createdAt = clock.now();
    const expiresAt = createdAt + sessionTtlMs;
    insertSession(db, { userId: user.id, tokenHash: hashToken(token), createdAt, expiresAt });
    return { ok: true, user: { username: user.username }, token, expiresAt };
  }

  /**
   * 幂等注销（REQ-003）：无论会话处于何种状态都不报错。
   * @param {string|undefined} token 客户端 Cookie 中的 token（可为空）
   * @returns {{ok:true}}
   */
  function logout(token) {
    if (typeof token === 'string' && token.length > 0) {
      revokeSessionByTokenHash(db, hashToken(token), clock.now());
    }
    return { ok: true };
  }

  /**
   * 解析会话（架构 §2 唯一权威判定）：
   * 存在 AND revoked_at IS NULL AND now < expires_at AND 用户启用（D-02 请求级状态检查），否则一律 null（不区分原因）。
   * 内部返回扩展为 {user:{id, username}, expiresAt}（id 供鉴权层解析权限；对外 /api/me 响应体不变，AD-09）。
   * @param {string|undefined} token
   * @returns {{user:{id:number, username:string}, expiresAt:number} | null}
   */
  function resolveSession(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const session = findSessionByTokenHash(db, hashToken(token));
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (clock.now() >= session.expiresAt) return null;
    const user = findUserById(db, session.userId);
    if (!user) return null;
    if (user.status !== 'active') return null;
    return { user: { id: user.id, username: user.username }, expiresAt: session.expiresAt };
  }

  /**
   * 清理过期会话记录（REQ-009）：删除 expires_at <= now() 的行。
   * @returns {number} 删除行数
   */
  function cleanupExpiredSessions() {
    return deleteExpiredSessions(db, clock.now());
  }

  return { register, login, logout, resolveSession, cleanupExpiredSessions };
}
