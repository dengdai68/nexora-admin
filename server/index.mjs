/**
 * 服务入口（DEV-01/AD-09）：装配 config/clock/db/service/http，启动与优雅退出。
 * 过期清理三条路径之生产路径：启动时执行一次 + 每小时定时扫描（unref，不阻止进程退出）。
 * NEXORA-RBAC-011：迁移后调用 syncPermissionCatalog（AD-06），装配审计/管理领域服务与管理路由。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { systemClock } from './clock.mjs';
import { createLogger } from './logger.mjs';
import { openMigratedDatabase } from './migrations.mjs';
import { createAuthService } from './auth-service.mjs';
import { buildRoutes } from './routes.mjs';
import { createHttpServer } from './http-server.mjs';
import { syncPermissionCatalog } from './permissions.mjs';
import { createAuditService } from './audit-service.mjs';
import { createAdminService } from './admin-service.mjs';
import { buildAdminRoutes } from './admin-routes.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(REPO_ROOT, 'web');
const STATIC_FILES = {
  '/': 'index.html',
  '/styles.css': 'styles.css',
  '/app.js': 'app.js',
  '/admin.js': 'admin.js',
  '/admin-users.js': 'admin-users.js',
  '/admin-roles.js': 'admin-roles.js',
  '/admin-catalog.js': 'admin-catalog.js',
  '/admin-audit.js': 'admin-audit.js',
};
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时

/**
 * 装配并返回应用（测试线束可注入 config/clock/logger）。
 * @param {{config?: object, clock?: {now:()=>number}, logger?: object}} [overrides]
 */
export function createApp(overrides = {}) {
  const config = overrides.config ?? loadConfig();
  const clock = overrides.clock ?? systemClock();
  const logger = overrides.logger ?? createLogger();
  const db = openMigratedDatabase(config.dbPath);
  const syncDiff = syncPermissionCatalog(db);
  if (syncDiff.addedKeys.length > 0 || syncDiff.grantedToSuperAdmin.length > 0) {
    logger.info(
      `permission catalog synced added_keys=${syncDiff.addedKeys.length} granted_to_super_admin=${syncDiff.grantedToSuperAdmin.length}`,
    );
  }
  const authService = createAuthService({ db, clock, sessionTtlMs: config.sessionTtlMs });
  const auditService = createAuditService({ db, clock });
  const adminService = createAdminService({ db, clock, auditService });
  const routes = [
    ...buildRoutes({ authService, config, repoRoot: REPO_ROOT, db }),
    ...buildAdminRoutes({ db, authService, adminService, auditService }),
  ];
  const server = createHttpServer({ routes, staticDir: WEB_DIR, staticFiles: STATIC_FILES, logger });
  return { config, clock, logger, db, authService, auditService, adminService, server };
}

/**
 * 启动服务：启动时清理一次过期会话 + 每小时 unref 扫描。
 * @returns {Promise<{close: () => Promise<void>}>}
 */
export async function startApp(app) {
  const removed = app.authService.cleanupExpiredSessions();
  app.logger.info(`startup cleanup expired_sessions_removed=${removed}`);
  const timer = setInterval(() => {
    const n = app.authService.cleanupExpiredSessions();
    if (n > 0) app.logger.info(`scheduled cleanup expired_sessions_removed=${n}`);
  }, CLEANUP_INTERVAL_MS);
  timer.unref();

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(app.config.port, app.config.host, resolve);
  });
  app.logger.info(`listening host=${app.config.host} port=${app.config.port}`);

  const close = () =>
    new Promise((resolve) => {
      clearInterval(timer);
      app.server.close(() => {
        app.db.close();
        resolve();
      });
    });
  return { close };
}

// 直接执行时启动服务
if (import.meta.url === `file://${process.argv[1]}`) {
  let handle;
  try {
    const app = createApp();
    handle = await startApp(app);
  } catch (err) {
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  }
  const shutdown = async (signal) => {
    console.log(`收到 ${signal}，正在优雅退出`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
