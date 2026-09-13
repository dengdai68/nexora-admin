/**
 * 测试种子（REQ-011、AC-09）：显式命令执行（npm run seed），不作为服务启动副作用。
 * 创建 seed_user（密码 Seed@12345，经 passwords.mjs 真实 scrypt 哈希入库），
 * 供复现验证「密码列为带盐哈希、会话列仅存 token 哈希」。
 */
import { openMigratedDatabase } from './migrations.mjs';
import { findUserByUsername, insertUser } from './db.mjs';
import { hashPassword } from './passwords.mjs';

export const SEED_USERNAME = 'seed_user';
export const SEED_PASSWORD = 'Seed@12345';

/**
 * 向指定数据库写入种子数据（幂等：已存在则跳过）。
 * @param {string} dbPath
 * @returns {{created: boolean, username: string}}
 */
export function seedDatabase(dbPath) {
  const db = openMigratedDatabase(dbPath);
  try {
    if (findUserByUsername(db, SEED_USERNAME)) {
      return { created: false, username: SEED_USERNAME };
    }
    insertUser(db, { username: SEED_USERNAME, passwordHash: hashPassword(SEED_PASSWORD), createdAt: Date.now() });
    return { created: true, username: SEED_USERNAME };
  } finally {
    db.close();
  }
}

// 直接执行时作为脚本入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.NEXORA_DB_PATH || 'data/nexora.db';
  const result = seedDatabase(dbPath);
  console.log(
    result.created
      ? `种子已写入 ${dbPath}：${result.username}（密码列已带盐哈希）`
      : `种子用户 ${result.username} 已存在，跳过`,
  );
}
