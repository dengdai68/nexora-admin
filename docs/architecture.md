# 架构说明（仓库落盘版）

> 与 `docs/api.md` 共同构成冻结契约。实现与本文件不一致时视为缺陷。
> NEXORA-RBAC-011 起新增「RBAC 权限管理」章节；既有登录/会话契约不变。

## 1. 分层

```text
web/（静态前端） → server/http-server.mjs + routes.mjs + admin-routes.mjs（HTTP 层）
→ server/auth-service.mjs（认证领域） / admin-service.mjs（管理领域）
→ server/{db,migrations}.mjs（数据访问，node:sqlite）
authz.mjs（鉴权纯领域） → {db, permissions}.mjs；audit-service.mjs → db.mjs
```

- `web/` 只通过 HTTP 与后端交互，不含领域规则。
- `http-server.mjs` 只承载路由（精确匹配优先 + `:param` 模式段）/解析/错误边界/静态资源，不含领域规则。
- 领域服务不感知 HTTP；所有时间判定走注入时钟（`clock.mjs`）。
- 依赖单向：`routes → auth-service → {passwords, tokens, db}`；`admin-routes → {authz, admin-service, audit-service, permissions}`；`admin-service → {authz, audit-service, db}`；`migrations → {db, permissions}`；`bootstrap-admin → {migrations, db, audit-service}`。禁止反向依赖。
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

认证两态模型（未认证 / 已认证）不变：

| 资源 | 未认证 | 已认证 |
| --- | --- | --- |
| 静态资源、/api/register、/api/login、/api/health | 允许 | 允许 |
| /api/me、/api/resource、/api/me/permissions | 401 | 允许 |
| /api/logout | 200（幂等，无副作用） | 200（撤销当前会话） |
| /api/admin/* | 401 | 按 RBAC 逐端点鉴权（无权限 403） |

`requireSession`（routes.mjs）统一执行「解析 Cookie → SHA-256 → 按 token_hash 查询 → 有效性判定（注入时钟 + 用户启用状态检查）」；权限判定唯一权威在后端，前端视图切换只是呈现。

### 4.1 RBAC 模型（NEXORA-RBAC-011）

- **实体**：User（+status）、Role（key/name/description/status/is_builtin）、Permission（目录）、UserRole、RolePermission、AuditEvent。
- **并集模型**：用户有效权限 = 其所有**已启用**角色的权限并集，每请求单条联表 SQL 实时解析（无缓存）；角色启停/授权变更下一请求即生效。
- **默认拒绝**：目录外 key 永不进入并集（外键 + 目录只读）；新注册用户无任何角色与后台权限。
- **权限目录**：`server/permissions.mjs` 的 `PERMISSION_CATALOG` 为唯一权威（10 项，`<module>:<action>` 稳定命名）；v003 迁移首次种子，启动时 `syncPermissionCatalog` 幂等同步元数据并保证 super_admin 全覆盖；无任何目录写接口。
- **内置 super_admin**：v003 种子角色，持有目录全量权限；本体受保护（任何操作者普通编辑/启停/删除/改权限 → 403 role_protected）；其绑定仅 super_admin 可管理。保护判定先于载荷校验（路径寻址不依赖请求体）：目标为内置角色时无论载荷如何一律 403 并按 AD-11 写 denied 审计（DEF-01 修复口径），admin-service 事务内的同款判定为权威兜底。
- **防提权（服务端强制）**：
  - P-02 分配/撤销 super_admin 绑定仅 super_admin；
  - P-03/P-04 普通授权者新增授权（角色权限 key / 用户角色绑定）必须是其自身有效权限子集，否则 403 grant_out_of_scope；
  - P-05 super_admin 成员的启停仅 super_admin 可操作；
  - P-06 最后一名启用 super_admin：禁用/撤权在同一 BEGIN IMMEDIATE 事务内做计数校验，并发下最多一单成功（409 last_super_admin）。
- **用户禁用语义**：禁用即在事务内撤销其全部会话 + 请求级状态检查（resolveSession 双重防护）；重新启用不复活已撤销会话；禁用用户登录返回与密码错误逐字节一致的 401（防枚举）。
- **CSRF**：`/api/admin/*` 写方法必须携带自定义头 `X-Nexora-CSRF: 1`（跨站简单请求无法携带自定义头，叠加 SameSite=Lax + 仅 JSON 415 形成纵深防御）；既有 register/login/logout 不加该校验以保持冻结契约。
- **审计**：写操作 {用户启停、用户授权、角色新建/编辑/启停/删除、角色授权、引导授权} 的成功与被拒绝事件全量落 `audit_events`（操作者快照/对象/动作/前后差异/结果/原因/时间）；只读接口 403 仅进请求日志；detail 键白名单防御，永不记录凭据。
- **管理 API 寻址**：用户以 username（唯一、不可改、URL 安全），角色以数值 id（key 可编辑）。

### 4.2 数据模型新增（迁移 v002/v003，只追加）

- v002：`users.status TEXT NOT NULL DEFAULT 'active'`（存量回填 active）+ `roles` / `permissions` / `role_permissions` / `user_roles` / `audit_events` 五表及索引；**全库不使用 ON DELETE CASCADE**（角色删除须先解除绑定，不静默级联）。
- v003：按目录常量种子 permissions 10 行 + 内置 super_admin 角色并授予全量权限；**不创建任何 user_roles 绑定**（迁移不自动提升任何账号）。
- 升级路径：备份 DB 文件 → 启动自动应用 v002/v003（幂等）→ 旧用户/会话行为不变；回退 = 恢复备份 + 回滚代码版本。

### 4.3 首位管理员引导

`npm run bootstrap:admin -- --username <已注册用户名>`（本机 CLI，AD-12）：仅对已存在账号授权；账号不存在明确失败（退出码 1）且不创建账号、不触碰密码；幂等（已绑定退出码 0 不重复写审计）；单事务 + INSERT OR IGNORE 收敛并发；审计动作 `admin.bootstrap`（actor `system:bootstrap`）。

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
