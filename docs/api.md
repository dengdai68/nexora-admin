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

`GET /` → `web/index.html`；`GET /styles.css`、`GET /app.js`。路径白名单 + 归一化防目录穿越；非白名单 → 404。静态资源不需要会话。
