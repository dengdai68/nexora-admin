# DEF-02：管理壳视图切换无并发防护，慢响应晚到覆盖当前视图（hash/导航与内容不一致）

| 项 | 值 |
| --- | --- |
| 编号 | DEF-02（NEXORA-RBAC-011）／系统缺陷 ID `defect_mu08kgcn_y3` |
| 状态 | ✅ **已验证关闭**（regression 节点，2026-09-14） |
| 严重度 | medium |
| 发现人 | Nexora · 测试工程师（testing 节点） |
| 发现日期 | 2026-09-14 |
| 被测版本 | `0e7915bcb0de1581751219651793079a1d49ee77`（feat/nexora-rbac-011-rbac） |
| 关联验收 | AC-02/AC-03 区域（FR-01 导航与页面正确性）：视图内容与导航/hash 必须一致，否则用户可能在错误视图下操作 |
| 关联证据 | tests/browser/def-02-view-race-repro.mjs（确定性复现脚本）；docs/testing/evidence/def-02-view-race.png |

## 描述

`web/admin.js` 的 `renderView(viewId)` 为异步函数：先 `renderNav()`（更新高亮与 hash），再 `await view.render(content, ctx)` 拉取数据并写入共享容器 `#admin-content`。连续快速切换视图时，**先发起的慢请求若后返回，会把旧视图内容覆盖到当前视图之上**，造成 `location.hash`/导航高亮与内容区不一致。

真实浏览器中实测（CDP Fetch 域挂起 `/api/admin/users` 模拟慢响应）：进入后台默认渲染「用户管理」（请求被挂起）→ 点击「授权审计」→ 审计页正常渲染（`hash=#/admin/audit`，高亮 audit）→ 放行挂起的用户列表响应 → 内容区被覆盖为「用户管理」，而 hash 与高亮仍停留在 audit。

证据截图 `def-02-view-race.png`：导航高亮在「授权审计」，内容区却是「用户管理」列表。

## 复现步骤

```bash
node tests/browser/def-02-view-race-repro.mjs
```

实际输出（2026-09-14 实测，Chrome/152.0.7977.83 headless=new）：

```text
审计页已渲染，hash = #/admin/audit
放行后：page-title=用户管理，hash=#/admin/audit，导航高亮=audit
✔ DEF-02 复现成立：内容被旧响应覆盖，与 hash/导航不一致
```

复现原理：CDP `Fetch.enable` 拦截 `*/api/admin/*`，仅挂起 `/api/admin/users` 请求；审计页渲染完成后 `Fetch.continueRequest` 放行慢响应。

此外，浏览器证据采集脚本在未加防护的连续导航场景下，该竞态以约 1/3 概率自然触发（6 次运行中 2 次 S10 超时，诊断快照显示 `page-title=用户管理 | hash=#/admin/audit`）。

## 期望行为

视图切换应具备并发防护：每次 `renderView` 分配递增序号（generation token），异步渲染完成后仅当序号仍为最新时才允许写入容器；或在发起新渲染前取消/忽略旧渲染的写回。渲染完成后视图内容必须与 `currentView`/hash 一致。

## 影响

- 用户快速切换导航时可能看到与导航/hash 不符的陈旧内容；在该状态下执行操作（如启停、授权）针对的是用户以为的另一个页面，存在误操作风险。
- 不涉及越权（服务端逐 API 守卫仍是权威），属前端状态一致性缺陷。

## 回归验证（regression 节点，tested SHA = `0e7918d71b0ba19a97d86150af26dc0a1dadfe29`）

修复方案（bug_fix 提交 `0e7918d`）：`renderView` 引入递增 generation + 分离暂存容器（stage），仅最新世代允许写回内容区；过期渲染整体丢弃。

确定性复现脚本原样重跑（连续 3 次）：

```text
审计页已渲染，hash = #/admin/audit
放行后：page-title=授权审计，hash=#/admin/audit，导航高亮=audit
✖ 未复现   ← 连续 3 次一致（第 1/2/3 次输出相同）
```

- ✅ 慢响应晚到被丢弃，内容与 hash/导航高亮保持一致
- ✅ 修复版一致状态截图：`docs/testing/evidence/def-02-view-race-fixed.png`（bug_fix 留存）与 `def-02-view-race-run.png`（本次回归运行留存）；原始缺陷截图 `def-02-view-race.png` 保持未动
- ✅ 浏览器全流程证据脚本已移除规避等待，直接走原竞态路径（进入后台立即快切审计页），连续 3 次 14/14 步通过，无抖动
- ✅ DOM 替身门控双场景回归随全量 e2e 78/78 通过
