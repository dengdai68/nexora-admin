# 测试说明

## 运行方法

```bash
npm test           # 单元测试（node:test，tests/unit/）
npm run test:e2e   # 真实 HTTP 黑盒 + DOM 替身（tests/e2e/）
```

要求 Node.js ≥ 22.5（`node --version` 验证；node:sqlite 内置模块要求）。

## 覆盖形态说明（区分浏览器 / 非浏览器）

| 目录 | 形态 | 说明 |
| --- | --- | --- |
| `tests/unit/` | 非浏览器（node:test 直接执行） | validation / passwords / tokens / migrations / seed / auth-service（fake clock 复现 24h 绝对过期与不续期）；NEXORA-RBAC-011 新增：migrations-rbac（v001 旧库升级/幂等/外键）、rbac-catalog（目录合法性与启动同步幂等）、rbac-authz（并集/禁用剔除/子集/最后管理员/禁用会话语义）、rbac-audit（字段/筛选/脱敏白名单）、rbac-validation（管理接口输入边界）、rbac-consistency（AC-14 目录⇄路由双向映射）、rbac-bootstrap（引导四路径）、rbac-tree-state（权限树状态机纯函数） |
| `tests/e2e/`（除 frontend-dom / frontend-admin-dom） | **真实 HTTP 服务**（非浏览器客户端，手动 Cookie jar） | server-harness 起真实服务（临时目录 DB、随机端口、可注入 TTL/SHA），覆盖主链路、通用 401、Cookie 属性、过期 401、清理证据、多会话隔离、参数边界、413/415/404/405、路径穿越、日志脱敏；NEXORA-RBAC-011 新增：admin-access（401/403 守卫矩阵/目录/审计/405 回归）、admin-roles（CRUD/保护矩阵/原子替换/CSRF）、admin-users（启停/授权/撤权即时/并发最后管理员）、rbac-closure（F-01 端到端闭环 + XSS/SQL 注入）、rbac-upgrade（v001 旧库升级演练）、bootstrap-cli（真实子进程退出码） |
| `tests/e2e/frontend-dom.test.mjs`、`tests/e2e/frontend-admin-dom.test.mjs` | DOM 替身（**非浏览器**） | 显隐切换、登录失败三路径清空密码保留用户名、401 回登录视图、注册引导；管理端：导航按权限渲染、无权限态、四态组件、权限树 DOM 交互（回显/半选/四按钮/保存载荷）、用户授权面板、CSRF 头注入、XSS 只落文本节点、零 innerHTML 静态扫描；真实浏览器交互归测试工程师黑盒覆盖 |

## 时间相关机制（AC-12 支撑）

- 单测：`server/clock.mjs` 的 `fakeClock` 注入领域服务，推进 24h 验证绝对过期与不续期。
- e2e：`NEXORA_SESSION_TTL_MS`（数百毫秒）起真实服务实测过期 401；默认 TTL 恒为 86400000（24h）。
- 清理证据：`cleanupExpiredSessions()` 公开导出，用例直接调用并断言过期行删除。
