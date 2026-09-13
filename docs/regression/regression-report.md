# NEXORA-RBAC-011 回归测试报告（regression 节点）

## 0. 元信息

| 项 | 值 |
| --- | --- |
| 需求编号 | NEXORA-RBAC-011 |
| 节点 | regression（回归测试与发布结论） |
| 负责人 | Nexora · 测试工程师（agent_mtpl1uog_78r） |
| 日期 | 2026-09-14 |
| 状态 | ✅ **测试通过，可发布** |
| 仓库 | `repos/nexora-admin`，remote = `https://github.com/dengdai68/nexora-admin.git` |
| 回归对象 | bug_fix 修复版本（DEF-01/DEF-02） |
| **tested commit SHA** | `0e7918d71b0ba19a97d86150af26dc0a1dadfe29`（feat/nexora-rbac-011-rbac） |
| 远程核对 | `git ls-remote origin feat/nexora-rbac-011-rbac` = `0e7918d71b0ba19a97d86150af26dc0a1dadfe29`（一致）；`origin/main` = `66f5854b54b60eebb1b3f840ac24ca0b6aa9e5cd`（未被直推） |
| 工作区状态 | 回归开始时 `git status --porcelain` 为空（干净），HEAD 与远程分支一致 |
| 回归节点新增提交 | 仅含回归报告、缺陷单状态闭环、修复版浏览器证据刷新与复现脚本输出名修正；不修改产品代码 |
| 执行环境 | macOS Darwin 25.4.0（arm64）、Node v24.7.0、npm 11.5.1、Google Chrome 152.0.7977.83（headless=new，CDP 驱动）、零 npm 外部依赖 |
| 数据隔离 | 全部用例使用隔离临时 SQLite 与虚构用户；未读取/复用旧任务产物；未触碰 4322 端口与现行服务数据 |

## 1. 输入核验

- 上游交接充分：testing 节点报告（docs/testing/test-report.md，2 个开放缺陷+复现用例）→ bug_fix 节点修复交付（commit `0e7918d`，本地=远程一致，FIX-D1 决策已确认）。
- 修复 diff 审查（`git show 0e7918d`）：范围精准——`server/admin-routes.mjs`（DEF-01 前置保护）、`web/admin.js`（DEF-02 渲染世代）、新增回归用例与修复证据截图、`docs/architecture.md` 一句保护顺序说明；无范围外变更，依赖与环境变量零变更。
- 两缺陷修复方案与缺陷单「期望行为」逐条对齐（保护判定先于载荷校验；generation token 仅最新世代写回）。

## 2. 回归执行（真实命令与输出）

### 2.1 全量套件连续 3 次（含独立验证与修复回归用例）

```text
$ npm test                # 单元
ℹ tests 69 / pass 69 / fail 0          # 第 1/2/3 次一致

$ npm run test:e2e        # 真实 HTTP + DOM 替身（含 independent-verify 15 项与 DEF-01/DEF-02 修复回归组）
ℹ tests 78 / pass 78 / fail 0          # 第 1/2/3 次一致
```

### 2.2 DEF-01（defect_mu08kgcn_y2）闭环验证——缺陷单复现脚本原样重跑

```text
super_admin role id = 1
A 改名保留key → 403 {"error":{"code":"role_protected","message":"内置超级管理员角色受保护，不可编辑"}}
B 改key合法载荷 → 403 {"error":{"code":"role_protected","message":"内置超级管理员角色受保护，不可编辑"}}
role.update denied 审计条数 = 2 ["role_protected","role_protected"]
尝试后 super_admin 名称 = 超级管理员 （未被修改）
```

- 两条路径均 403 role_protected（契约/AC-12 达成），两次被拒绝尝试均写审计，super_admin 未被修改。
- 缺陷复现用例 IND-06 转绿：`node --test tests/e2e/independent-verify.test.mjs` → **tests 15 / pass 15 / fail 0**。

### 2.3 DEF-02（defect_mu08kgcn_y3）闭环验证——确定性复现脚本连续 3 次

```text
$ node tests/browser/def-02-view-race-repro.mjs   # ×3
审计页已渲染，hash = #/admin/audit
放行后：page-title=授权审计，hash=#/admin/audit，导航高亮=audit
✖ 未复现   （第 1/2/3 次输出逐字节一致）
```

- 慢响应晚到被世代机制丢弃，内容与 hash/导航高亮一致；修复版运行截图 `docs/testing/evidence/def-02-view-race-run.png`（另 bug_fix 留存 `def-02-view-race-fixed.png`），原始缺陷截图 `def-02-view-race.png` 保持未动。
- 复现脚本输出文件名修正为 `def-02-view-race-run.png`，避免覆盖原始缺陷证据。

### 2.4 真实浏览器全流程复跑（修复版本，连续 3 次 14/14 通过）

```text
$ node tests/browser/cdp-evidence.mjs    # ×3，Chrome/152.0.7977.83
✔ 准备：注册 + 真实 CLI 引导（退出码 0）
✔ S1 登录视图 → S2 admin 登录 → S3 四入口导航 → S4 建角色
✔ S5 权限树父子联动/半选/计数 → S6 保存回显服务端核对 → S7 用户授权保存服务端核对
✔ S8 受限导航 → S9 撤权无权限态 + 底层 API 403 → S10 审计留痕检索 → S11 375px 窄屏
✔ 全程 Runtime.exceptionThrown = 0
全部 14 步通过（连续 3 次）
```

回归增强：证据脚本已**移除**测试期为规避 DEF-02 而加的「等待首视图就绪」步骤，S10 直接走原竞态路径（进入后台立即快切审计页），连续 3 次无抖动——竞态场景在修复后稳定正确。证据截图已在修复版本刷新（evidence-log.json 记录 commitSha=0e7918d）。

## 3. 缺陷闭环结论

| 缺陷 ID | 标题 | 修复 commit | 回归证据 | 结论 |
| --- | --- | --- | --- | --- |
| defect_mu08kgcn_y2 | super_admin 保留 key 改名 400 而非 403 role_protected 且无审计 | `0e7918d` | §2.2 原路径重跑 + IND-06 转绿 + 全量 e2e 78/78 | ✅ 验证关闭 |
| defect_mu08kgcn_y3 | 管理壳视图切换竞态 | `0e7918d` | §2.3 复现脚本 3 次未复现 + §2.4 全流程原竞态路径 3 次通过 | ✅ 验证关闭 |

缺陷单已更新为「已验证关闭」并附回归证据：docs/testing/defects/DEF-01-*.md、DEF-02-*.md。

## 4. 验收标准覆盖（回归视角）

testing 节点已逐条覆盖 AC-01~AC-40（docs/testing/test-report.md §3）。本回归在修复版本 `0e7918d` 上确认：

- 唯一不通过项 **AC-12 转通过**（DEF-01 闭环，§2.2）。
- DEF-02 关联的导航一致性风险消除（§2.3/§2.4）。
- 其余全部验收路径在修复版本上无回归：unit 69/69、e2e 78/78（含既有登录注册契约、迁移幂等、并发最后超管、CSRF/注入/审计全部用例）连续 3 次稳定。
- AC-36/AC-40 归发布节点承接。

## 5. 结论

**测试通过，可发布。** 修复版本 `0e7918d71b0ba19a97d86150af26dc0a1dadfe29` 上：两个缺陷全部验证关闭，全量自动化（unit 69 + e2e 78）连续 3 次全绿，真实浏览器关键授权流程 14 步连续 3 次通过，无开放缺陷。交接发布节点：以 `0e7918d` 为待合并版本执行非破坏性合并 main、4322 部署与 health 一致性核验。

## 6. 限制声明（如实）

1. 浏览器证据为真实 Google Chrome（headless=new 完整引擎，CDP 驱动）整页截图与 DOM 断言，非有头人工点击；脚本已提交可复跑。
2. 并发验证为单进程真实事件循环交错（BEGIN IMMEDIATE 串行化），非多进程压测。
3. 窄屏验证为 375px 单点；浏览器矩阵仅 Chrome。
4. 回归全部使用隔离临时 SQLite 与虚构用户；迁移演练基于 v001 旧库副本，未接触现行服务数据。
