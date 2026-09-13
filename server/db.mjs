/**
 * 数据访问层（node:sqlite）：打开/关闭数据库、PRAGMA、users/sessions 小粒度访问函数。
 * 只负责 SQL 与行映射，不含领域规则（领域规则在 auth-service.mjs）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 打开（必要时创建）SQLite 数据库并启用外键约束。
 * @param {string} dbPath 数据库文件路径，':memory:' 表示内存库
 * @returns {DatabaseSync}
 */
export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

/**
 * 关闭数据库。
 * @param {DatabaseSync} db
 */
export function closeDatabase(db) {
  db.close();
}

// ---------- users ----------

/**
 * 插入用户。
 * @param {DatabaseSync} db
 * @param {{username: string, passwordHash: string, createdAt: number}} user
 * @returns {number} 新用户 id
 */
export function insertUser(db, { username, passwordHash, createdAt }) {
  const stmt = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
  const result = stmt.run(username, passwordHash, createdAt);
  return Number(result.lastInsertRowid);
}

/**
 * 按用户名精确查找用户。
 * @param {DatabaseSync} db
 * @param {string} username
 * @returns {{id:number, username:string, passwordHash:string, createdAt:number} | null}
 */
export function findUserByUsername(db, username) {
  const row = db
    .prepare('SELECT id, username, password_hash, created_at FROM users WHERE username = ?')
    .get(username);
  return row ? mapUserRow(row) : null;
}

/** @param {number} id */
export function findUserById(db, id) {
  const row = db.prepare('SELECT id, username, password_hash, created_at FROM users WHERE id = ?').get(id);
  return row ? mapUserRow(row) : null;
}

function mapUserRow(row) {
  return {
    id: Number(row.id),
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: Number(row.created_at),
  };
}

// ---------- sessions ----------

/**
 * 写入会话（token 仅存 SHA-256 哈希）。
 * @param {DatabaseSync} db
 * @param {{userId:number, tokenHash:string, createdAt:number, expiresAt:number}} session
 * @returns {number} 会话 id
 */
export function insertSession(db, { userId, tokenHash, createdAt, expiresAt }) {
  const stmt = db.prepare(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
  );
  const result = stmt.run(userId, tokenHash, createdAt, expiresAt);
  return Number(result.lastInsertRowid);
}

/**
 * 按 token 哈希查找会话。
 * @returns {{id:number, userId:number, tokenHash:string, createdAt:number, expiresAt:number, revokedAt:number|null} | null}
 */
export function findSessionByTokenHash(db, tokenHash) {
  const row = db
    .prepare(
      'SELECT id, user_id, token_hash, created_at, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
    )
    .get(tokenHash);
  return row ? mapSessionRow(row) : null;
}

/**
 * 幂等撤销会话：无论当前是否已撤销都返回成功；返回是否在本次调用中新撤销。
 * @returns {{revoked: boolean}} revoked=true 表示本次调用首次设置 revoked_at
 */
export function revokeSessionByTokenHash(db, tokenHash, revokedAt) {
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(revokedAt, tokenHash);
  return { revoked: result.changes > 0 };
}

/**
 * 删除已过期会话（expires_at <= nowMs）。
 * @returns {number} 删除行数
 */
export function deleteExpiredSessions(db, nowMs) {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs);
  return Number(result.changes);
}

/**
 * 统计会话行数（测试断言用）。
 * @returns {number}
 */
export function countSessions(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
  return Number(row.n);
}

function mapSessionRow(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tokenHash: row.token_hash,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  };
}
