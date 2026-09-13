# AGENTS.md — AI 协作说明

> 本文件面向维护本仓库的 AI 与人类协作者。修改代码前请先读完本文件与 `docs/architecture.md`、`docs/api.md`。

## 仓库概览

云枢后台登录注册与会话应用。**零外部 npm 依赖**：Node.js 内置 HTTP + `node:sqlite` + `node:crypto` + 原生前端。要求 Node.js ≥ 22.5。

## 结构与职责

```text
server/index.mjs        入口：装配 config/clock/db/service/http，启动清理 + 每小时过期扫描，优雅退出
server/config.mjs       白名单 5 环境变量解析，非法值快速失败
server/clock.mjs        时钟抽象：systemClock / fakeClock（测试注入）
server/logger.mjs       最小日志器：只记录方法/路径/状态码/稳定错误码
server/validation.mjs   用户名/密码边界校验（纯函数，注册登录共用）
server/passwords.mjs    scrypt 带盐哈希与校验（timingSafeEqual，畸形返回 false）
server/tokens.mjs       token 生成（32B 随机）与 SHA-256 哈希
server/db.mjs           node:sqlite 打开/PRAGMA 与 users/sessions 小粒度访问函数
server/migrations.mjs   版本化迁移（schema_migrations + v001；新变更只追加 v002+）
server/seed.mjs         测试种子（npm run seed 显式执行）
server/auth-service.mjs 领域服务：register/login/logout/resolveSession/cleanupExpiredSessions
server/http-server.mjs  内置 http：路由表、JSON 解析、Cookie 工具、错误边界、静态资源白名单
server/routes.mjs       五个 API 端点处理器（契约见 docs/api.md）
web/                    原生前端：单页三视图，统一 fetch 封装，401 回登录视图
tests/                  unit（node:test）+ e2e（真实 HTTP 服务 + DOM 替身）
docs/                   architecture.md（模块/数据/权限/流程）、api.md（接口契约）
```

依赖方向：`routes.mjs → auth-service.mjs → {passwords,tokens,db}.mjs`；`http-server.mjs` 不含领域规则；`web/` 只经 HTTP 交互。禁止跨层反向依赖。

## 常用命令

```bash
npm start          # 启动（127.0.0.1:4322）
npm test           # 单元测试
npm run test:e2e   # e2e 黑盒（真实 HTTP）
npm run seed       # 测试种子
```

## 不可违反的约定

1. **接口契约冻结**：字段名/状态码/错误格式以 `docs/api.md` 为准；偏离须先修订设计与契约文档。
2. **日志脱敏**：任何日志不得出现明文密码、token 本体、Cookie 头值、请求体；logger 只接收方法/路径/状态码/稳定错误码。
3. **持久化红线**：密码只存 scrypt 带盐哈希；会话只存 token 的 SHA-256 哈希；token 本体仅出现在登录响应的 Set-Cookie。
4. **会话口径**：24 小时绝对过期，`expires_at` 落库后不变（不续期）；有效性判定唯一权威在 `auth-service.resolveSession`。
5. **环境变量白名单**：仅 `NEXORA_HOST/NEXORA_PORT/NEXORA_DB_PATH/NEXORA_SESSION_TTL_MS/APP_COMMIT_SHA`；不读取其他环境变量；`/api/health` 只暴露 status 与 version。
6. **不引入外部依赖**：不添加任何 npm 包、框架、构建工具。
7. **不提交运行期产物**：`data/`、`logs/`、`node_modules/`、`VERSION` 已被 .gitignore 排除。
8. 变更非平凡路径须补测试：`npm test` 与 `npm run test:e2e` 必须全绿。
