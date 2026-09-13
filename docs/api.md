# 接口契约（冻结）

> 字段名 / 状态码 / 错误格式以本文件为准，测试与发布断言依据。任何偏离须先修订本契约。

## 通用约定

- 仅接受/返回 `application/json; charset=utf-8`。
- 请求体上限 16 KB（超出 → 413 `payload_too_large`）。
- POST 非 JSON Content-Type → 415 `unsupported_media_type`；JSON 解析失败 → 400 `invalid_json`。
- 未知 API 路径 → 404 `not_found`；方法不允许 → 405 `method_not_allowed`（带 `Allow` 头）。
- 错误统一格式：

```json
{ "error": { "code": "<stable_code>", "message": "<short actionable text>" } }
```

400 参数错误附加字段级信息（仅校验结论，不泄露内部细节）：

```json
{ "error": { "code": "invalid_params", "message": "参数不合法", "fields": { "username": "...", "password": "..." } } }
```

## POST /api/register（公开）

- 请求：`{"username": "...", "password": "..."}`
- 校验（注册与登录共用同一套边界）：username 必填、3–32 字符、仅 `[A-Za-z0-9_-]`；password 必填、8–128 字符。
- `201`：`{"user":{"username":"..."}}`；**不创建会话、不下发 Cookie、响应不含密码/哈希**。
- `400 invalid_params`：空值/超长/非法字符/结构错误。
- `409 username_taken`：用户名已存在（仅注册路径暴露占用事实）。

## POST /api/login（公开）

- 请求：同注册结构。
- `400 invalid_params`：参数格式非法（字段级错误）。
- `401 invalid_credentials`：格式合法但凭据错误；**用户不存在与密码错误返回逐字节一致的响应体与状态码**；服务端对不存在用户执行 dummy scrypt 校验对齐时延。
- `200`：`{"user":{"username":"..."},"session":{"expiresAt":<ms>}}` + 响应头：

```text
Set-Cookie: nexora_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400
```

loopback 开发模式不设 `Secure`；token 本体只出现在本响应的 Set-Cookie 中。

## POST /api/logout（幂等，公开入口）

- 无请求体要求；读取 Cookie（可有可无可有效可无效）。
- 行为：解析出有效会话则设置 `revoked_at`；已注销/过期/伪造/无 Cookie 不报错。
- 一律 `200` `{"ok":true}`（相同成功语义），并始终下发：

```text
Set-Cookie: nexora_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0
```

## GET /api/me（受保护）

- `401 unauthorized`：无/伪造/过期/已注销会话。
- `200`：`{"user":{"username":"..."},"session":{"expiresAt":<ms>}}`。

## GET /api/resource（受保护示例资源）

- `401 unauthorized`：同 /api/me。
- `200`：`{"resource":{"title":"云枢后台示例资源","owner":"<username>"}}`。

## GET /api/health（公开）

- `200`：`{"status":"ok","version":"<commit-sha>"}`。
- version 解析顺序：`APP_COMMIT_SHA` 环境变量 → 仓库根 `VERSION` 文件首行 → `"unknown"`。实现只读该命名变量与 VERSION 文件，**不得读取/返回任意环境变量、凭据、内部路径**。
- 发布验收：该值与 `git ls-remote origin main` 比对（发布以 `APP_COMMIT_SHA=$(git rev-parse HEAD)` 注入启动）。

## 静态资源

`GET /` → `web/index.html`；`GET /styles.css`、`/app.js`、`/admin.js`、`/admin-users.js`、`/admin-roles.js`、`/admin-catalog.js`、`/admin-audit.js`。路径白名单 + 归一化防目录穿越；非白名单 → 404。静态资源不需要会话。

---

# 管理 API（NEXORA-RBAC-011）

## 管理通用约定

- 通用约定沿用上文（JSON、16KB、错误格式）。
- **鉴权**：全部 `/api/admin/*` 端点需有效会话；未登录 → `401 unauthorized`；已登录但无对应权限 → `403 forbidden`。
- **CSRF**：全部 `/api/admin/*` 写方法（POST/PUT/DELETE/PATCH）必须携带请求头 `X-Nexora-CSRF: 1`，缺失或错误 → `403 csrf_protection`（读方法与既有 register/login/logout 不要求该头）。
- **分页**：`page` ≥1 默认 1；`pageSize` 1–50 默认 20；响应 `{items, total, page, pageSize}`；越界页 `items: []`。
- **搜索**：`q` ≤64 字符，大小写不敏感子串匹配（参数化 LIKE，`%`/`_`/`\` 转义）。
- 未知对象 → `404 not_found`；非法分页/筛选参数 → `400 invalid_params`（fields 指明字段）。
- 写操作整体校验：任何未知/重复/非法输入 → 整体 `400`，无部分成功；合法提交为原子替换。
- 服务端不信任请求体中的身份/角色/权限字段；对象寻址仅来自路径参数，操作者仅来自会话。

## GET /api/me/permissions（需会话）

- `401 unauthorized`：同 /api/me。
- `200`：`{"permissions":["user:read", ...]}`——调用者有效权限（已启用角色权限并集，排序去重；普通用户为空数组）。

## 用户管理

### GET /api/admin/users（user:read）

- 查询：`q` `page` `pageSize`。
- `200`：`items: [{username, status("active"|"disabled"), roles: [{id, key, name, status}], createdAt}]` + 分页字段。

### GET /api/admin/users/:username（user:read）

- `200`：`{user: {...同列表项}}`；`404 not_found`。

### POST /api/admin/users/:username/status（user:status）

- 请求：`{"status": "active" | "disabled"}`。
- 行为：禁用即在同一事务内撤销该用户全部会话（旧会话立即 401，重新启用不复活）；禁用用户登录返回与密码错误逐字节一致的 401。
- `200`：`{user: {username, status}}`。
- `403 super_admin_required`：目标持有 super_admin 绑定但操作者不是 super_admin。
- `409 last_super_admin`：将使最后一名启用 super_admin 失效。

### PUT /api/admin/users/:username/roles（user:assign_roles）

- 请求：`{"roleIds": [整数...]}`——全量替换目标用户角色绑定（原子）。空数组合法（全撤销）。
- 校验：元素为正整数、无重复、长度 ≤ 角色总数；id 全部存在；**新增**绑定的角色必须为启用状态（保留已有绑定不受限，解除绑定不受限）。任一不满足 → `400 invalid_params`。
- `200`：`{user: {...详情}}`。
- `403 super_admin_required`：分配/撤销 super_admin 角色但操作者不是 super_admin。
- `403 grant_out_of_scope`：新增角色的有效权限超出操作者自身有效权限（message 列出越权 key）。
- `409 last_super_admin`：撤销将使最后一名启用 super_admin 失效。

## 角色管理

### GET /api/admin/roles（role:read）

- `200`：`items: [{id, key, name, description, status, isBuiltin, permissionCount, userCount, createdAt, updatedAt}]` + 分页字段。

### GET /api/admin/roles/enabled（user:assign_roles）

- 用户授权页可选角色源：`200`：`{items: [{id, key, name, status}]}`——全部启用角色，不分页。

### GET /api/admin/roles/:id（role:read）

- `200`：`{role: {...列表字段, permissionKeys: [排序后的权限 key], boundUsers: 绑定用户数}}`；`404 not_found`。

### POST /api/admin/roles（role:create）

- 请求：`{"name": "1–50 字符", "key": "2–50 字符 ^[a-z][a-z0-9_]*$（super_admin 为保留字）", "description": "≤200 字符可空"}`。
- `201`：`{role: {...}}`，新角色权限集为空。
- `400 invalid_params`：边界/格式/保留字（fields 指明）。
- `409 role_key_taken`：唯一标识冲突，不写入。

### PUT /api/admin/roles/:id（role:update）

- 请求同新建。super_admin 角色 → `403 role_protected`（任何操作者）。
- `200`：`{role: {...}}`；`409 role_key_taken`。

### POST /api/admin/roles/:id/status（role:update）

- 请求：`{"status": "active" | "disabled"}`；super_admin → `403 role_protected`。
- `200`：`{role: {...}}`。禁用即时从所有持有者的有效权限并集中剔除（下一请求生效）。

### DELETE /api/admin/roles/:id（role:delete）

- super_admin → `403 role_protected`。
- 仍绑定用户 → `409 role_in_use`（message 含绑定数量与至多 3 个示例用户名；不删除、不级联）。
- `200`：`{"ok": true}`（同事务显式清理权限绑定）。

### PUT /api/admin/roles/:id/permissions（role:assign_permissions）

- 请求：`{"permissionKeys": ["user:read", ...]}`——服务端校验后**原子替换**角色权限集。
- 校验：字符串数组、无重复、长度 ≤ 目录总数、全部 ∈ 权限目录；未知 key → `400 invalid_params`（`fields.permissionKeys` 列出未知清单），无部分成功。
- super_admin → `403 role_protected`；新增 key 超出操作者有效权限 → `403 grant_out_of_scope`。
- `200`：`{role: {...含最新 permissionKeys}}`。

## 权限目录（只读）

### GET /api/admin/permissions（permission:read）

- `200`：`{groups: [{module, name, items: [{key, name, description, page, apis: ["METHOD /path", ...]}]}]}`，按 sort_order 排序。
- 目录由代码常量 + 版本化迁移维护，无任何写接口；分组节点仅组织展示，不是可授予权限。

## 授权审计（只读）

### GET /api/admin/audit-events（audit:read）

- 查询：`actor`（操作者用户名子串）、`target`（对象标识/展示名子串）、`action`（精确动作码）、`from`/`to`（毫秒整数闭区间）、`page`/`pageSize`。
- `200`：`items: [{id, actorUsername, action, targetType, targetId, targetLabel, result("success"|"denied"), reason, detail, createdAt}]`（按 id 倒序）+ 分页字段。
- 动作码：`user.status` / `user.assign_roles` / `role.create` / `role.update` / `role.status` / `role.delete` / `role.assign_permissions` / `admin.bootstrap`。
- 记录口径：上述写操作的成功与被拒绝（403/409 关键拒绝）事件；只读接口的 403 仅进请求日志。任何记录不含密码、token、Cookie 或凭据。

## 首位管理员引导（本机 CLI，不是 HTTP 端点）

```bash
npm run bootstrap:admin -- --username <已注册用户名>
```

- 仅对已存在账号授予内置 super_admin 角色；账号不存在 → 明确失败（退出码 1），不创建账号、不触碰密码。
- 幂等：已绑定 → 退出码 0 且不重复写审计；授权 + 审计单事务，并发执行收敛为单次生效。
- 审计动作 `admin.bootstrap`，操作者 `system:bootstrap`。
