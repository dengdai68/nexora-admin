/**
 * 首位管理员引导（NEXORA-RBAC-011 / AD-12 / FR-12 / AC-35）：
 * 本机显式执行 `npm run bootstrap:admin -- --username admin`，对已存在账号授予内置 super_admin 角色。
 * 安全口径：账号不存在则明确失败（退出码 1），不创建账号、不触碰密码；已绑定则幂等成功（退出码 0），
 * 不重复写审计；授权与审计在单事务内完成；并发执行靠主键 + INSERT OR IGNORE 收敛为单次生效。
 * 本脚本不包含、不读取、不写入任何密码或凭据。
 */
import { openMigratedDatabase } from './migrations.mjs';
import { findRoleByKey, findUserByUsername, withTransaction } from './db.mjs';
import { SUPER_ADMIN_ROLE_KEY } from './permissions.mjs';
import { AUDIT_ACTIONS, createAuditService } from './audit-service.mjs';
import { systemClock } from './clock.mjs';

/** 引导操作者标识（审计 actor；actor_user_id 为 NULL 表示系统）。 */
export const BOOTSTRAP_ACTOR = 'system:bootstrap';

/**
 * 引导核心（可注入依赖，测试直接调用）。
 * @param {import('node:sqlite').DatabaseSync} db 已迁移数据库
 * @param {{record: Function}} auditService 审计服务
 * @param {string} username 目标用户名（必须已通过注册接口存在）
 * @param {number} now 当前毫秒时间戳
 * @returns {{status: 'granted' | 'already' | 'no_user' | 'no_super_admin_role'}}
 */
export function bootstrapAdmin(db, auditService, username, now) {
  const user = findUserByUsername(db, username);
  if (!user) return { status: 'no_user' };
  const role = findRoleByKey(db, SUPER_ADMIN_ROLE_KEY);
  if (!role) return { status: 'no_super_admin_role' };
  return withTransaction(db, () => {
    const result = db
      .prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, created_at) VALUES (?, ?, NULL, ?)')
      .run(user.id, role.id, now);
    if (result.changes === 0) return { status: 'already' }; // 幂等：已绑定（含并发收敛），不重复写审计
    auditService.record({
      actor: { id: null, username: BOOTSTRAP_ACTOR },
      action: AUDIT_ACTIONS.ADMIN_BOOTSTRAP,
      target: { type: 'user', id: user.username, label: user.username },
      result: 'success',
      detail: { after: { role: SUPER_ADMIN_ROLE_KEY } },
    });
    return { status: 'granted' };
  });
}

/** 用法说明（参数错误时输出）。 */
const USAGE = '用法：npm run bootstrap:admin -- --username <用户名>';

/**
 * 解析 CLI 参数：仅接受 `--username <name>` 一对参数。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ok:true, username:string} | {ok:false}}
 */
export function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === '--username' && argv[1].length > 0) {
    return { ok: true, username: argv[1] };
  }
  return { ok: false };
}

// 直接执行时作为 CLI 入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(USAGE);
    process.exit(2);
  }
  const dbPath = process.env.NEXORA_DB_PATH || 'data/nexora.db';
  const db = openMigratedDatabase(dbPath);
  try {
    const auditService = createAuditService({ db, clock: systemClock() });
    const result = bootstrapAdmin(db, auditService, parsed.username, Date.now());
    switch (result.status) {
      case 'granted':
        console.log(`已将账号 ${parsed.username} 授予超级管理员（super_admin），审计已记录`);
        process.exit(0);
        break;
      case 'already':
        console.log(`账号 ${parsed.username} 已是超级管理员（幂等，无变更）`);
        process.exit(0);
        break;
      case 'no_user':
        console.error(`账号 ${parsed.username} 不存在：请先通过注册接口创建该账号；本脚本不创建账号、不处理密码`);
        process.exit(1);
        break;
      default:
        console.error('内置 super_admin 角色不存在：数据库未完成 v003 迁移');
        process.exit(1);
    }
  } finally {
    db.close();
  }
}
