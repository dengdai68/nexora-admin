# 测试说明

## 运行方法

```bash
npm test           # 单元测试（node:test，tests/unit/）
npm run test:e2e   # 真实 HTTP 黑盒 + DOM 替身（tests/e2e/，含测试工程师独立验证 independent-verify）

# 真实浏览器证据（需本机安装 Google Chrome，零 npm 依赖，CDP 驱动）：
node tests/browser/cdp-evidence.mjs              # 关键授权流程 14 步 + 截图（输出 docs/testing/evidence/）
node tests/browser/def-02-view-race-repro.mjs    # DEF-02 视图切换竞态确定性复现
```

要求 Node.js ≥ 22.5（`node --version` 验证；node:sqlite 内置模块要求）。

## 覆盖形态说明（区分浏览器 / 非浏览器）

| 目录 | 形态 | 说明 |
| --- | --- | --- |
| `tests/unit/` | 非浏览器（node:test 直接执行） | validation / passwords / tokens / migrations / seed / auth-service（fake clock 复现 24h 绝对过期与不续期）；NEXORA-RBAC-011 新增：migrations-rbac（v001 旧库升级/幂等/外键）、rbac-catalog（目录合法性与启动同步幂等）、rbac-authz（并集/禁用剔除/子集/最后管理员/禁用会话语义）、rbac-audit（字段/筛选/脱敏白名单）、rbac-validation（管理接口输入边界）、rbac-consistency（AC-14 目录⇄路由双向映射）、rbac-bootstrap（引导四路径）、rbac-tree-state（权限树状态机纯函数） |
| `tests/e2e/`（除 frontend-dom / frontend-admin-dom） | **真实 HTTP 服务**（非浏览器客户端，手动 Cookie jar） | server-harness 起真实服务（临时目录 DB、随机端口、可注入 TTL/SHA），覆盖主链路、通用 401、Cookie 属性、过期 401、清理证据、多会话隔离、参数边界、413/415/404/405、路径穿越、日志脱敏；NEXORA-RBAC-011 新增：admin-access（401/403 守卫矩阵/目录/审计/405 回归）、admin-roles（CRUD/保护矩阵/原子替换/CSRF）、admin-users（启停/授权/撤权即时/并发最后管理员）、rbac-closure（F-01 端到端闭环 + XSS/SQL 注入）、rbac-upgrade（v001 旧库升级演练）、bootstrap-cli（真实子进程退出码） |
| `tests/e2e/frontend-dom.test.mjs`、`tests/e2e/frontend-admin-dom.test.mjs` | DOM 替身（**非浏览器**） | 显隐切换、登录失败三路径清空密码保留用户名、401 回登录视图、注册引导；管理端：导航按权限渲染、无权限态、四态组件、权限树 DOM 交互（回显/半选/四按钮/保存载荷）、用户授权面板、CSRF 头注入、XSS 只落文本节点、零 innerHTML 静态扫描；真实浏览器交互归测试工程师黑盒覆盖 |
| `tests/e2e/independent-verify.test.mjs` | **真实 HTTP 服务**（测试工程师独立验证，IND-01~IND-15） | 断言独立于研发用例编写：F-01 闭环、401/403 全端点矩阵、CSRF 全写端点、伪造字段、授权子集、super_admin 保护矩阵（IND-06 为 DEF-01 复现，修复前为红色）、最后超管并发、禁用双保险、原子替换、注入防线、审计五维、分页边界、冻结契约 |
| `tests/browser/` | **真实浏览器**（Google Chrome headless=new，CDP 远程调试，Node 内置 WebSocket，零第三方依赖） | cdp-evidence.mjs：登录→四入口→建角色→权限树（联动/半选/计数）→保存回显服务端核对→用户授权→受限导航→撤权无权限态+底层 403→审计检索→375px 窄屏，14 步截图证据；def-02-view-race-repro.mjs：Fetch 域挂起慢响应确定性复现 DEF-02 |

## 时间相关机制（AC-12 支撑）

- 单测：`server/clock.mjs` 的 `fakeClock` 注入领域服务，推进 24h 验证绝对过期与不续期。
- e2e：`NEXORA_SESSION_TTL_MS`（数百毫秒）起真实服务实测过期 401；默认 TTL 恒为 86400000（24h）。
- 清理证据：`cleanupExpiredSessions()` 公开导出，用例直接调用并断言过期行删除。
