/**
 * 会话 token 原语（REQ-013）：token = 32 字节（256 bit ≥ 128 bit）随机值，
 * base64url 编码下发；持久化层只保存 SHA-256 十六进制哈希。
 */
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

/**
 * 生成新会话 token（base64url，URL/Cookie 安全）。
 * @returns {string}
 */
export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * 计算 token 的持久化哈希（SHA-256 十六进制）。
 * @param {string} token
 * @returns {string} 64 字符十六进制
 */
export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const TOKEN_RANDOM_BYTES = TOKEN_BYTES;
