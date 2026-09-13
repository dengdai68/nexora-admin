# nexora-admin（云枢后台 · 登录注册会话与权限管理）

## 功能简介

零外部依赖的后台管理应用：原生 HTML/CSS/JS 前端 + Node.js 内置 HTTP 服务 + `node:sqlite` 持久化 + `node:crypto` 安全原语。

**登录注册与会话（既有能力，契约不变）**

- 注册 / 登录 / 幂等注销 / 受保护当前用户与示例资源 / 健康与版本接口
- 密码 scrypt 带盐强哈希（每用户随机盐，永不存明文）；会话 token 256 bit 随机且持久化仅存 SHA-256 哈希
- 会话 **24 小时绝对过期**（自创建起算，任何认证活动不续期）；过期记录启动时 + 每小时定时清理
- 多会话隔离：同一用户多处登录互不影响，注销其一不影响其余
- 登录通用错误（401 同码同文案防枚举）；参数边界字段级 400；日志脱敏（不记明文密码 / token / Cookie 值）
- 会话 Cookie：`HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`；本机 loopback 开发模式不设 `Secure`

**权限管理（NEXORA-RBAC-011 新增）**

- 四个中文后台页面：用户管理 / 角色管理 / 权限目录 / 授权审计（按当前权限渲染入口，分页搜索，加载/空/失败/无权限四态，窄屏可用）
- RBAC 多对多模型：用户-角色-权限，有效权限 = 已启用角色权限并集，每请求实时解析，默认拒绝；角色启停/撤权下一请求即生效
- 角色管理：列表/搜索/详情/新建/编辑/启停/删除（绑定中返回明确冲突，不静默级联）；内置 super_admin 受保护
- 角色授权树：父子联动、半选态、全选全部/取消全选与搜索态「全选当前结果/取消当前结果」明确分离、已选计数、保存原子替换、刷新回显与数据库一致
- 用户授权：多角色分配/撤销、全选/取消全选、回显、原子保存；禁用用户即撤销全部会话，重新启用不复活旧会话
- 服务端权威鉴权：未登录 401 / 已登录无权限 403；管理写操作 CSRF 自定义头防护；防提权（授权子集约束、仅 super_admin 可管 super_admin、最后一名启用 super_admin 事务内并发保护）
- 授权与拒绝关键操作全量审计（操作者/对象/动作/前后差异/结果/原因/时间），分页筛选可检索，不含任何凭据
- 版本化迁移（v002/v003 只追加、幂等、保留旧用户与会话、不自动提权）+ 首位管理员本机引导 CLI（显式、幂等、写审计）

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

**首位管理员引导（升级后必做）**：迁移不会自动提升任何账号。确认目标账号已注册后，本机显式执行：

```bash
npm run bootstrap:admin -- --username admin
# 已存在账号 → 授予 super_admin 并写审计；重复执行幂等（不重复写审计）
# 账号不存在 → 明确失败（退出码 1），不创建账号、不触碰密码
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

# ---- 管理 API（需管理员会话；写操作必须携带 X-Nexora-CSRF: 1 头） ----
# 查看自身有效权限
curl -b cookies.txt http://127.0.0.1:4322/api/me/permissions    # {"permissions":[...]}

# 角色管理：新建 → 授权 → 绑定用户
curl -b cookies.txt -X POST http://127.0.0.1:4322/api/admin/roles \
  -H 'Content-Type: application/json' -H 'X-Nexora-CSRF: 1' \
  -d '{"name":"运营专员","key":"ops_lead","description":"负责运营"}'
curl -b cookies.txt -X PUT http://127.0.0.1:4322/api/admin/roles/2/permissions \
  -H 'Content-Type: application/json' -H 'X-Nexora-CSRF: 1' \
  -d '{"permissionKeys":["user:read"]}'
curl -b cookies.txt -X PUT http://127.0.0.1:4322/api/admin/users/alice_01/roles \
  -H 'Content-Type: application/json' -H 'X-Nexora-CSRF: 1' \
  -d '{"roleIds":[2]}'

# 权限目录（只读）与授权审计（筛选分页）
curl -b cookies.txt http://127.0.0.1:4322/api/admin/permissions
curl -b cookies.txt 'http://127.0.0.1:4322/api/admin/audit-events?action=role.create&page=1&pageSize=20'
```

浏览器直接打开 `http://127.0.0.1:4322/` 可完成 注册 → 手动登录 → 受保护欢迎区 →（管理员）进入后台管理 → 退出 的端到端操作。

完整接口契约（含错误码全集与权限矩阵）见 [docs/api.md](docs/api.md)。

## 测试方法

```bash
npm test           # 单元测试：validation/passwords/tokens/migrations/seed/auth-service（fake clock 复现 24h 过期）
                   #   + RBAC：目录一致性/启动同步/鉴权并集与防提权规则/审计/引导幂等/权限树状态机
npm run test:e2e   # 真实 HTTP 黑盒（临时 DB、随机端口）+ 前端 DOM 替身（非浏览器，见 tests/README.md）
                   #   + 管理 API 全覆盖、端到端授权闭环、升级演练、引导 CLI 真实进程、并发最后管理员保护
```

测试形态区分详见 [tests/README.md](tests/README.md)。

## 目录结构

```text
server/   HTTP 层（http-server/routes/admin-routes）、认证领域（auth-service）、管理领域（admin-service/authz）、
          审计（audit-service）、权限目录（permissions）、数据访问与迁移（db/migrations/seed/bootstrap-admin）、
          安全原语（passwords/tokens）、配置（config）、时钟（clock）、日志（logger）
web/      原生前端（index.html/styles.css/app.js + 管理四页面 admin*.js 五模块）
tests/    单元测试与真实 HTTP 黑盒
docs/     架构与接口契约说明
```

安全与日志约定、开发约束见 [AGENTS.md](AGENTS.md) 与 [docs/architecture.md](docs/architecture.md)。
