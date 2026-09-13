# nexora-admin（云枢后台 · 登录注册与会话）

## 功能简介

零外部依赖的登录注册与会话管理应用：原生 HTML/CSS/JS 前端 + Node.js 内置 HTTP 服务 + `node:sqlite` 持久化 + `node:crypto` 安全原语。

- 注册 / 登录 / 幂等注销 / 受保护当前用户与示例资源 / 健康与版本接口
- 密码 scrypt 带盐强哈希（每用户随机盐，永不存明文）；会话 token 256 bit 随机且持久化仅存 SHA-256 哈希
- 会话 **24 小时绝对过期**（自创建起算，任何认证活动不续期）；过期记录启动时 + 每小时定时清理
- 多会话隔离：同一用户多处登录互不影响，注销其一不影响其余
- 登录通用错误（401 同码同文案防枚举）；参数边界字段级 400；日志脱敏（不记明文密码 / token / Cookie 值）
- 会话 Cookie：`HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`；本机 loopback 开发模式不设 `Secure`
- 前端：单页三视图（登录 / 注册 / 欢迎）、密码显隐切换、登录失败（401/5xx/网络）一致清空密码保留用户名

## 安装 / 运行步骤

要求 **Node.js ≥ 22.5**（`node:sqlite` 内置模块要求）：

```bash
node --version        # 验证版本，须 ≥ v22.5.0
npm start             # 启动服务，默认 127.0.0.1:4322
```

可选环境变量（白名单，仅这 5 个会被读取）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEXORA_HOST` | `127.0.0.1` | 监听地址 |
| `NEXORA_PORT` | `4322` | 监听端口 |
| `NEXORA_DB_PATH` | `data/nexora.db` | SQLite 数据库路径（运行期生成，不入库） |
| `NEXORA_SESSION_TTL_MS` | `86400000` | 会话有效期毫秒（默认 24h；测试可注入短 TTL 复现过期） |
| `APP_COMMIT_SHA` | 空 | 注入运行版本 commit SHA，`/api/health` 的 `version` 返回该值 |

发布验收启动方式（健康接口返回可比对 SHA）：

```bash
APP_COMMIT_SHA=$(git rev-parse HEAD) npm start
curl -s http://127.0.0.1:4322/api/health   # {"status":"ok","version":"<commit-sha>"}
```

测试种子（显式执行，非服务启动副作用）：

```bash
npm run seed          # 创建 seed_user（密码 Seed@12345，带盐哈希入库）
```

## 使用示例

```bash
# 注册（201，不创建会话、不下发 Cookie）
curl -i -X POST http://127.0.0.1:4322/api/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice_01","password":"Password@123"}'

# 登录（200 + Set-Cookie: nexora_session=...; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400）
curl -i -c cookies.txt -X POST http://127.0.0.1:4322/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice_01","password":"Password@123"}'

# 受保护接口
curl -b cookies.txt http://127.0.0.1:4322/api/me        # {"user":{"username":"alice_01"},"session":{"expiresAt":...}}
curl -b cookies.txt http://127.0.0.1:4322/api/resource  # {"resource":{"title":"云枢后台示例资源","owner":"alice_01"}}

# 幂等注销（有效/重复/无会话均 200 {"ok":true} 并清除 Cookie）
curl -i -b cookies.txt -c cookies.txt -X POST http://127.0.0.1:4322/api/logout -H 'Content-Type: application/json' -d '{}'
```

浏览器直接打开 `http://127.0.0.1:4322/` 可完成 注册 → 手动登录 → 受保护欢迎区 → 退出 的端到端操作。

完整接口契约见 [docs/api.md](docs/api.md)。

## 测试方法

```bash
npm test           # 单元测试：validation/passwords/tokens/migrations/seed/auth-service（fake clock 复现 24h 过期）
npm run test:e2e   # 真实 HTTP 黑盒（临时 DB、随机端口）+ 前端 DOM 替身（非浏览器，见 tests/README.md）
```

测试形态区分详见 [tests/README.md](tests/README.md)。

## 目录结构

```text
server/   HTTP 层（http-server/routes）、领域服务（auth-service）、数据访问与迁移（db/migrations/seed）、
          安全原语（passwords/tokens）、配置（config）、时钟（clock）、日志（logger）
web/      原生前端三视图（index.html/styles.css/app.js）
tests/    单元测试与真实 HTTP 黑盒
docs/     架构与接口契约说明
```

安全与日志约定、开发约束见 [AGENTS.md](AGENTS.md) 与 [docs/architecture.md](docs/architecture.md)。
