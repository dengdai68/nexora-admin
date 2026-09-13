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
| `tests/unit/` | 非浏览器（node:test 直接执行） | validation / passwords / tokens / migrations / seed / auth-service（fake clock 复现 24h 绝对过期与不续期） |
| `tests/e2e/`（除 frontend-dom） | **真实 HTTP 服务**（非浏览器客户端，手动 Cookie jar） | server-harness 起真实服务（临时目录 DB、随机端口、可注入 TTL/SHA），覆盖主链路、通用 401、Cookie 属性、过期 401、清理证据、多会话隔离、参数边界、413/415/404/405、路径穿越、日志脱敏 |
| `tests/e2e/frontend-dom.test.mjs` | DOM 替身（**非浏览器**） | 显隐切换、登录失败三路径清空密码保留用户名、401 回登录视图、注册引导；真实浏览器交互归测试工程师黑盒覆盖 |

## 时间相关机制（AC-12 支撑）

- 单测：`server/clock.mjs` 的 `fakeClock` 注入领域服务，推进 24h 验证绝对过期与不续期。
- e2e：`NEXORA_SESSION_TTL_MS`（数百毫秒）起真实服务实测过期 401；默认 TTL 恒为 86400000（24h）。
- 清理证据：`cleanupExpiredSessions()` 公开导出，用例直接调用并断言过期行删除。
