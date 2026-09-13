# AGENTS.md — AI 协作说明

> 本文件面向维护本仓库的 AI 与人类协作者。修改代码前请先读完本文件与 `docs/architecture.md`、`docs/api.md`。

## 仓库概览

云枢后台：登录注册与会话 + 完整权限管理（RBAC：用户/角色/权限目录/授权审计）。**零外部 npm 依赖**：Node.js 内置 HTTP + `node:sqlite` + `node:crypto` + 原生前端。要求 Node.js ≥ 22.5。

## 结构与职责

```text
server/index.mjs        入口：装配 config/clock/db/service/http，syncPermissionCatalog，启动清理 + 每小时过期扫描，优雅退出
server/config.mjs       白名单 5 环境变量解析，非法值快速失败
server/clock.mjs        时钟抽象：systemClock / fakeClock（测试注入）
server/logger.mjs       最小日志器：只记录方法/路径/状态码/稳定错误码
server/validation.mjs   输入校验纯函数：注册登录边界 + 管理接口载荷/分页/审计筛选
server/passwords.mjs    scrypt 带盐哈希与校验（timingSafeEqual，畸形返回 false）
server/tokens.mjs       token 生成（32B 随机）与 SHA-256 哈希
server/db.mjs           node:sqlite 打开/PRAGMA + users/sessions/RBAC 各表小粒度访问函数 + withTransaction
server/migrations.mjs   版本化迁移（v001 用户会话 / v002 RBAC 结构 / v003 目录与 super_admin 种子；只追加）
server/seed.mjs         测试种子（npm run seed 显式执行）
server/bootstrap-admin.mjs 首位管理员本机引导 CLI（npm run bootstrap:admin -- --username <名>；幂等、写审计、不涉密码）
server/auth-service.mjs 认证领域：register/login/logout/resolveSession（含用户启用检查）/cleanupExpiredSessions
server/permissions.mjs  权限目录唯一权威常量 + syncPermissionCatalog 启动同步
server/authz.mjs        鉴权纯领域：有效权限并集、super_admin 判定、授权子集、最后管理员保护
server/audit-service.mjs 审计写入（detail 键白名单脱敏）与分页筛选查询
server/admin-service.mjs 管理领域：用户/角色/授权操作（P-01~P-06 规则编排、事务边界、审计编排）
server/http-server.mjs  内置 http：路由表（精确优先 + :param 模式）、JSON 解析、Cookie 工具、错误边界、静态资源白名单
server/routes.mjs       认证五端点 + GET /api/me/permissions（契约见 docs/api.md）
server/admin-routes.mjs /api/admin/* 全部端点 + 守卫链（会话→CSRF→权限→业务规则）+ ADMIN_ROUTES_META（AC-14 断言源）
web/                    原生前端：登录/注册/欢迎 + 后台管理四页面（admin*.js 五模块），统一 fetch 封装（401 回登录、写方法注入 CSRF 头）
tests/                  unit（node:test）+ e2e（真实 HTTP 服务 + DOM 替身）
docs/                   architecture.md（模块/数据/权限/流程）、api.md（接口契约）
```

依赖方向：`routes → auth-service → {passwords,tokens,db}`；`admin-routes → {authz,admin-service,audit-service,permissions}`；`admin-service → {authz,audit-service,db}`；`authz → {db,permissions}`；`audit-service → db`；`migrations → {db,permissions}`；`bootstrap-admin → {migrations,db,audit-service}`；`web/` 只经 HTTP 交互。禁止跨层反向依赖。

## 常用命令

```bash
npm start          # 启动（127.0.0.1:4322）
npm test           # 单元测试
npm run test:e2e   # e2e 黑盒（真实 HTTP）
npm run seed       # 测试种子
npm run bootstrap:admin -- --username <已注册用户名>   # 首位管理员本机引导（幂等、写审计）
```

## 不可违反的约定

1. **接口契约冻结**：字段名/状态码/错误格式以 `docs/api.md` 为准；偏离须先修订设计与契约文档。
2. **日志脱敏**：任何日志不得出现明文密码、token 本体、Cookie 头值、请求体；logger 只接收方法/路径/状态码/稳定错误码。
3. **持久化红线**：密码只存 scrypt 带盐哈希；会话只存 token 的 SHA-256 哈希；token 本体仅出现在登录响应的 Set-Cookie。
4. **会话口径**：24 小时绝对过期，`expires_at` 落库后不变（不续期）；有效性判定唯一权威在 `auth-service.resolveSession`（含用户启用状态检查）。
5. **环境变量白名单**：仅 `NEXORA_HOST/NEXORA_PORT/NEXORA_DB_PATH/NEXORA_SESSION_TTL_MS/APP_COMMIT_SHA`；不读取其他环境变量；`/api/health` 只暴露 status 与 version。（NEXORA-RBAC-011 未新增任何环境变量，引导脚本复用 NEXORA_DB_PATH。）
6. **不引入外部依赖**：不添加任何 npm 包、框架、构建工具（NEXORA-RBAC-011 依赖零变更）。
7. **不提交运行期产物**：`data/`、`logs/`、`node_modules/`、`VERSION` 已被 .gitignore 排除。
8. 变更非平凡路径须补测试：`npm test` 与 `npm run test:e2e` 必须全绿。
9. **权限管理红线**：权限目录只由 `server/permissions.mjs` 常量 + 版本化迁移维护（无目录写接口）；super_admin 角色本体与其绑定保护规则、授权子集约束、最后一名启用 super_admin 事务内计数保护不得削弱；管理写操作 CSRF 头校验不得移除；审计 detail 键白名单不得加入凭据类字段。
