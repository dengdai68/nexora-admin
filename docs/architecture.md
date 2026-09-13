# 架构说明（仓库落盘版）

> 与 `docs/api.md` 共同构成冻结契约。实现与本文件不一致时视为缺陷。

## 1. 分层

```text
web/（静态前端） → server/http-server.mjs + routes.mjs（HTTP 层）
→ server/auth-service.mjs（领域服务） → server/{db,migrations}.mjs（数据访问，node:sqlite）
```

- `web/` 只通过 HTTP 与后端交互，不含领域规则。
- `http-server.mjs` 只承载路由/解析/错误边界/静态资源，不含领域规则。
- 领域服务不感知 HTTP；所有时间判定走注入时钟（`clock.mjs`）。
- 依赖单向：`routes → auth-service → {passwords, tokens, db}`；禁止反向依赖。
- 零外部 npm 依赖；Node.js ≥ 22.5。

## 2. 数据模型

迁移机制：`schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`，按版本升序幂等执行；新结构变更只追加 v002+。

### users

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK AUTOINCREMENT | 内部主键，不对外暴露 |
| username | TEXT NOT NULL UNIQUE | 精确匹配，3–32 字符 |
| password_hash | TEXT NOT NULL | `scrypt:N:r:p:saltB64:hashB64` |
| created_at | INTEGER NOT NULL | 毫秒时间戳 |

### sessions

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK AUTOINCREMENT | 内部主键 |
| user_id | INTEGER NOT NULL REFERENCES users(id) | 所属用户 |
| token_hash | TEXT NOT NULL（唯一索引） | token 的 SHA-256 十六进制；**永不存 token 本体** |
| created_at | INTEGER NOT NULL | 创建时间（毫秒） |
| expires_at | INTEGER NOT NULL（普通索引） | `created_at + TTL`，落库后不变（24h 绝对过期） |
| revoked_at | INTEGER NULL | 注销时间；幂等注销重复设置不报错 |

会话有效性唯一权威判定（`auth-service.resolveSession`）：

```text
valid = 会话存在 AND revoked_at IS NULL AND now < expires_at
```

不存在 / 哈希无匹配 / 已注销 / 已过期 → 一律 401，不区分原因。

测试种子：`npm run seed` 创建 `seed_user`（密码 `Seed@12345`，真实 scrypt 哈希入库），幂等。

## 3. 接口

冻结契约见 [api.md](api.md)：五个 API 端点 + 静态资源白名单。

## 4. 权限

两态模型（未认证 / 已认证）：

| 资源 | 未认证 | 已认证 |
| --- | --- | --- |
| 静态资源、/api/register、/api/login、/api/health | 允许 | 允许 |
| /api/me、/api/resource | 401 | 允许 |
| /api/logout | 200（幂等，无副作用） | 200（撤销当前会话） |

`requireSession`（routes.mjs）统一执行「解析 Cookie → SHA-256 → 按 token_hash 查询 → 有效性判定（注入时钟）」；权限判定唯一权威在后端，前端视图切换只是呈现。

## 5. 关键流程

- **注册**：边界校验（400 字段级）→ 唯一性（409）→ scrypt 入库 → 201，**不创建会话、不下发 Cookie**；前端引导回登录视图手动登录。
- **登录**：格式非法 → 400 字段级；凭据错误 → 401 通用（用户不存在时执行 dummy scrypt 校验对齐时延）；成功 → 32B token → 仅存哈希 → `expires_at = now + TTL` → Set-Cookie。
- **会话守卫与过期**：进入欢迎视图前 `GET /api/me`；统一 fetch 封装对任何受保护接口 401 → 回登录视图；24h 绝对过期不续期；过期清理 = 启动时一次 + 每小时 unref 定时扫描 + `cleanupExpiredSessions()` 公开导出（测试直接调用取清理证据）。
- **注销（幂等）**：有效/已注销/过期/伪造/无 Cookie 均 200 `{"ok":true}`，始终下发 `Max-Age=0` 清 Cookie。
- **多会话隔离**：每次登录一行独立 token；注销 A 不影响 B。

## 6. 安全要求

1. 密码：scrypt(N=16384, r=8, p=1, keylen=64) + 每用户 16B 随机盐；`timingSafeEqual` 校验；存储格式自带参数版本。
2. token：`crypto.randomBytes(32)`（256 bit）base64url 下发；SHA-256 十六进制入库；日志与响应体永不出现 token 本体。
3. Cookie：`nexora_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`；loopback 开发模式不设 `Secure`；仅 Cookie 通道，不支持 Bearer。CSRF 缓解 = SameSite + HttpOnly + 仅 JSON 接口。
4. 防枚举：登录 401 同码同文案 + dummy 校验对齐时延。
5. 日志脱敏：logger 只接收方法/路径/状态码/稳定错误码；禁止请求体/密码/token/Cookie 值。
6. 配置边界：仅白名单 5 个环境变量（`NEXORA_HOST` / `NEXORA_PORT` / `NEXORA_DB_PATH` / `NEXORA_SESSION_TTL_MS` / `APP_COMMIT_SHA`）；`/api/health` 只暴露 status 与 version，version 解析顺序 `APP_COMMIT_SHA` → 仓库根 `VERSION` 文件 → `"unknown"`。

## 7. 测试可达性

| 机制 | 形态 | 用途 |
| --- | --- | --- |
| 可注入时钟 | `clock.mjs`（fakeClock 注入服务装配） | 单测推进 24h 验证绝对过期与不续期 |
| TTL 显式配置 | `NEXORA_SESSION_TTL_MS`（默认 86400000） | e2e 数百毫秒 TTL 起真实服务实测过期 401 |
| 清理函数 | `cleanupExpiredSessions()` 公开导出 | 断言过期行删除（清理证据） |
| 测试种子 | `npm run seed` | 存储形态复现验证 |
| e2e 线束 | `tests/e2e/server-harness.mjs`（临时 DB、随机端口、注入配置） | 真实 HTTP 黑盒 |

以上均为显式文档化能力，不改变生产默认口径（默认 TTL 恒为 24h）。

## 8. 部署注意

- 默认监听 `127.0.0.1:4322`（loopback 开发模式；非本机部署不在当前范围）。
- 发布验收以 `APP_COMMIT_SHA=$(git rev-parse HEAD)` 注入启动，`/api/health` 的 `version` 与 `git ls-remote origin main` 比对。
- 数据库文件、日志、`VERSION` 均为运行期产物，已被 `.gitignore` 排除，不得提交。
