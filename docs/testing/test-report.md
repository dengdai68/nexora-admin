# NEXORA-RBAC-011 测试报告（独立测试节点）

## 0. 元信息

| 项 | 值 |
| --- | --- |
| 需求编号 | NEXORA-RBAC-011 |
| 节点 | testing（测试设计与质量验证） |
| 负责人 | Nexora · 测试工程师（agent_mtpl1uog_78r） |
| 日期 | 2026-09-14 |
| 状态 | ❌ **测试未全通过：2 个开放缺陷（DEF-01/DEF-02），待 bug_fix 后回归** |
| 仓库 | `repos/nexora-admin`，remote = `https://github.com/dengdai68/nexora-admin.git` |
| 被测代码 SHA（tested） | `0e7915bcb0de1581751219651793079a1d49ee77`（feat/nexora-rbac-011-rbac，研发交付版本） |
| 远程核对 | `git ls-remote origin feat/nexora-rbac-011-rbac` = `0e7915bcb0de1581751219651793079a1d49ee77`（一致）；`origin/main` = `66f5854b54b60eebb1b3f840ac24ca0b6aa9e5cd`（未被直推） |
| 工作区状态 | 测试开始时 `git status --porcelain` 为空（干净）；HEAD 与远程分支一致 |
| 测试节点新增提交 | 测试资产与文档随需求分支交付（`420fc40` 起，定稿以 `git ls-remote origin feat/nexora-rbac-011-rbac` 实测为准）——仅含测试资产与文档（tests/e2e/independent-verify.test.mjs、tests/browser/*、docs/testing/*、tests/README.md 增补），不修改任何产品代码；被测产品代码 SHA 恒为 `0e7915bcb0de1581751219651793079a1d49ee77` |
| 执行环境 | macOS Darwin 25.4.0（arm64）、Node v24.7.0（≥22.5）、npm 11.5.1、Google Chrome 152.0.7977.83（headless=new，完整 Blink/V8，CDP 驱动）、零 npm 外部依赖 |
| 数据隔离 | 全部自动化用例使用 server-harness 隔离临时 SQLite + 虚构用户；未读取/复用旧任务任何产物；未触碰 4322 端口与任何现行服务数据 |

## 1. 基线核验（真实命令输出）

```text
$ git remote -v
origin  https://github.com/dengdai68/nexora-admin.git (fetch)
origin  https://github.com/dengdai68/nexora-admin.git (push)
$ git rev-parse HEAD
0e7915bcb0de1581751219651793079a1d49ee77
$ git status --porcelain        # （空输出 = 干净）
$ git ls-remote origin
66f5854b54b60eebb1b3f840ac24ca0b6aa9e5cd  HEAD
cff9c0341191e1cedce160944948931208bb687e  refs/heads/feat/nexora-e2e-008-auth-sessions
0e7915bcb0de1581751219651793079a1d49ee77  refs/heads/feat/nexora-rbac-011-rbac
66f5854b54b60eebb1b3f840ac24ca0b6aa9e5cd  refs/heads/main
```

## 2. 执行汇总（真实命令与输出）

### 2.1 研发交付套件独立复跑（连续 3 次，验证并发用例稳定性）

```text
$ npm test            # 单元，tests/unit/
ℹ tests 69 / ℹ pass 69 / ℹ fail 0          # 第 1/2/3 次结果一致

$ npm run test:e2e    # 真实 HTTP + DOM 替身，tests/e2e/（研发交付部分）
ℹ tests 61 / ℹ pass 61 / ℹ fail 0          # 第 1/2/3 次结果一致
```

### 2.2 测试工程师独立验证（断言独立编写，15 用例）

```text
$ node --test tests/e2e/independent-verify.test.mjs
✔ IND-01 F-01 端到端闭环（建角色→授权→绑用户→登录→获准200/未获准403→撤权下一请求403）
✔ IND-02 401/403 语义矩阵（14 端点，未登录 401 / 无权限 403 不混用）
✔ IND-03 CSRF（7 写端点缺失/错误头 → 403 csrf_protection）
✔ IND-04 伪造身份/角色/permission 字段被忽略；审计操作者只来自会话
✔ IND-05 授权子集约束（grant_out_of_scope 列越权 key + 审计；被拒后权限集不变）
✖ IND-06 super_admin 保护矩阵 → DEF-01（保留 key 改名 400 而非 403 role_protected，且无审计）
✔ IND-07 最后超管：禁用/撤权 409；并发互相禁用至多一单成功且始终 ≥1 启用超管
✔ IND-08 禁用双保险：旧会话 401、启用不复活、禁用登录与密码错误/用户不存在逐字节一致
✔ IND-09 原子替换精确等于提交集；未知/重复/非字符串整体 400 无部分成功
✔ IND-10 key 冲突 409；删除绑定中角色 409 含数量与示例；解绑后可删
✔ IND-11 LIKE 通配符转义、SQL 注入无泄露、XSS 载荷纯文本存取、审计无凭据
✔ IND-12 审计五维筛选 + 字段完整 + 前后差异
✔ IND-13 多角色并集与禁用叠加精确
✔ IND-14 分页/搜索参数边界（page=0、pageSize=51、q 超长 → 400；越界页空集）
✔ IND-15 /api/me 形状冻结、health version、注销幂等清 Cookie
ℹ tests 15 / pass 14 / fail 1（唯一失败即 DEF-01 复现）
```

含独立验证的全量 e2e：`npm run test:e2e` → **tests 76 / pass 75 / fail 1**（fail=IND-06=DEF-01）。

### 2.3 真实浏览器证据（C-04 闭环，Google Chrome CDP，零第三方依赖）

```text
$ node tests/browser/cdp-evidence.mjs     # 连续 3 次完整通过（14 步 × 3）
✔ 准备：注册 web_admin/web_user + 真实 CLI 引导（退出码 0）
✔ 启动真实浏览器 —— Chrome/152.0.7977.83
✔ S1 登录视图 → S2 admin 登录（进入后台管理入口）→ S3 四中文入口导航
✔ S4 浏览器新建角色 web_ops → S5 权限树父子联动/半选/计数（已选 4 项权限）
✔ S6 保存后回显与数据库一致（浏览器内经同源会话核对服务端 permissionKeys）
✔ S7 用户授权保存（服务端核对 web_user.roles 含 web_ops）
✔ S8 web_user 仅见获准入口（用户管理|角色管理）
✔ S9 撤权后 web_user 无权限态 + 浏览器内实测底层 API 403
✔ S10 审计页检索全流程留痕（引导授权/角色新建/角色授权/用户授权，含操作者与对象）
✔ S11 375px 窄屏导航与表格横滚适配
✔ 全程 Runtime.exceptionThrown = 0（无页面 JS 异常）
```

截图与证据日志：`docs/testing/evidence/01~11-*.png`、`evidence-log.json`（含浏览器版本、commitSha、每步断言结果）。
说明：headless=new 为 Chrome 完整渲染/JS 引擎（非 DOM 替身），截图为整页真实渲染结果；采集脚本可重复执行复现。

### 2.4 缺陷确定性复现

```text
$ node tests/browser/def-02-view-race-repro.mjs
审计页已渲染，hash = #/admin/audit
放行后：page-title=用户管理，hash=#/admin/audit，导航高亮=audit
✔ DEF-02 复现成立：内容被旧响应覆盖，与 hash/导航不一致
```

DEF-01 复现见 `docs/testing/defects/DEF-01-super-admin-rename-400-no-audit.md` 内嵌命令与实测输出。

## 3. 验收标准逐条结论（AC-01~AC-40）

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC-01 四入口可见可进 | ✅ 通过 | 浏览器 S3（截图 03）；E admin-dom |
| AC-02 无权限入口隐藏+直达无权限态+API 403 | ✅ 通过 | 浏览器 S8/S9（截图 08/09）；IND-02；E admin-dom |
| AC-03 分页搜索与四态 | ✅ 通过 | E admin-dom 四态；IND-14 分页边界；浏览器分页器入镜 |
| AC-04 ≥360px 窄屏 | ✅ 通过 | 浏览器 S11（截图 11，375px；表格横滚为设计适配，关键操作经横滚可达） |
| AC-05 多角色并集 | ✅ 通过 | IND-13；U rbac-authz |
| AC-06 角色禁用即时生效/恢复 | ✅ 通过 | IND-01/IND-13；U rbac-authz |
| AC-07 新注册零权限 | ✅ 通过 | IND-01（注册响应键、直调 403、空权限数组） |
| AC-08 未知 key 默认拒绝 | ✅ 通过 | IND-09；E admin-roles |
| AC-09 角色全流程持久化 | ✅ 通过 | E admin-roles；浏览器 S4 |
| AC-10 key 冲突 409 | ✅ 通过 | IND-10 |
| AC-11 删除冲突 409 含数量示例、不级联 | ✅ 通过 | IND-10 |
| AC-12 super_admin 普通编辑/删除/禁用 403+审计 | ❌ **不通过（DEF-01）** | 启停/删除/改权限/改 key 路径 403 role_protected+审计通过；**保留 key 改名路径 400 且无审计** |
| AC-13 目录分组/字段/只读搜索 | ✅ 通过 | E admin-access；浏览器目录页 |
| AC-14 目录⇄路由双向一致 | ✅ 通过 | U rbac-consistency |
| AC-15 父子联动/半选 | ✅ 通过 | U rbac-tree-state；E admin-dom；浏览器 S5（截图 05 半选横杠） |
| AC-16 全选/取消全选/计数/组不隐含授予 | ✅ 通过 | U rbac-tree-state；浏览器 S5 计数 |
| AC-17 搜索全选范围隔离/两档全选不混淆 | ✅ 通过 | U rbac-tree-state；E admin-dom |
| AC-18 保存回显与 DB 一致/取消无改动 | ✅ 通过 | 浏览器 S6（服务端核对）；E admin-dom |
| AC-19 非法输入整体拒绝/原子替换 | ✅ 通过 | IND-09；E admin-roles |
| AC-20 用户角色与状态展示 | ✅ 通过 | 浏览器 S7/S8（截图 07/08）；E admin-users |
| AC-21 多角色授权原子化/回显 | ✅ 通过 | 浏览器 S7（服务端核对）；E admin-users；U rbac-validation |
| AC-22 禁用阻断旧会话/启用不复活/禁用登录防枚举 | ✅ 通过 | IND-08（逐字节一致断言） |
| AC-23 撤权下一请求 403 | ✅ 通过 | IND-01/IND-13；浏览器 S9（API=403） |
| AC-24 401/403 语义不混用 | ✅ 通过 | IND-02（14 端点矩阵）；E admin-access |
| AC-25 伪造字段忽略 | ✅ 通过 | IND-04 |
| AC-26 仅超管管超管绑定 | ✅ 通过 | IND-06（403 super_admin_required+审计） |
| AC-27 授权子集约束 | ✅ 通过 | IND-05 |
| AC-28 最后超管并发保护 | ✅ 通过 | IND-07；E admin-users 并发（[200,409]/[200,401] 合法交错） |
| AC-29 超管角色权限集/绑定保护 | ✅ 通过 | IND-06；E admin-roles |
| AC-30 写操作 CSRF 防护 | ✅ 通过 | IND-03（7 写端点缺/错头全 403 csrf_protection） |
| AC-31 XSS/SQL 注入 | ✅ 通过 | IND-11；E rbac-closure；admin-dom 静态扫描零 innerHTML |
| AC-32 审计完整/筛选/脱敏 | ✅ 通过（附 DEF-01 缺口） | IND-12；U rbac-audit；浏览器 S10；DEF-01 单一路径审计缺口见缺陷单 |
| AC-33 迁移保留旧数据且幂等 | ✅ 通过 | E rbac-upgrade（v001 旧库演练）；U migrations-rbac |
| AC-34 迁移不自动提权 | ✅ 通过 | E rbac-upgrade；U migrations-seed（user_roles 为空） |
| AC-35 引导显式/幂等/审计/不写明文密码 | ✅ 通过 | E bootstrap-cli 真实子进程四路径；浏览器准备步真实 CLI 退出码 0 |
| AC-36 发布备份/回退记录 | ➡️ 归发布节点 | — |
| AC-37 既有契约回归 | ✅ 通过 | IND-15；E auth-flow/sessions/boundary/health；U 既有 31 项；415 行为与 main 基线逐行一致（已用 `git show main:` 核对） |
| AC-38 分支 SHA/不直推 main | ✅ 通过 | §1 基线核验 |
| AC-39 测试报告与浏览器证据 | ✅ 本报告 | 本报告 + docs/testing/evidence/ + test-cases.md |
| AC-40 合并部署 4322 | ➡️ 归发布节点 | — |

## 4. 开放缺陷清单（Markdown 报告见 docs/testing/defects/）

| 编号 | 标题 | 严重度 | 复现 | 影响面 |
| --- | --- | --- | --- | --- |
| DEF-01 | super_admin 保留 key 改名 → 400 invalid_params 而非 403 role_protected，且该拒绝不留审计 | medium | IND-06（红色）；缺陷单内嵌一次性命令实测输出 | AC-12 契约状态码偏离 + 针对最高权限角色的编辑企图审计不可见；无越权、无数据变更 |
| DEF-02 | 管理壳视图切换无并发防护：慢响应晚到覆盖当前视图，hash/导航高亮与内容不一致 | medium | tests/browser/def-02-view-race-repro.mjs 确定性复现 + 截图 def-02-view-race.png；证据脚本自然触发率约 1/3 | 快速导航可见陈旧内容并存误操作风险；不越权（服务端守卫权威） |

## 5. 测试范围与限制（如实声明）

1. **浏览器证据为真实 Google Chrome（headless=new 模式）**：完整 Blink 渲染与 V8 执行、真实 Cookie/fetch/DOM 交互，经 CDP 驱动与整页截图；非有头窗口人工点击。采集脚本已提交可复跑。
2. 并发验证为单进程真实事件循环交错（node:sqlite BEGIN IMMEDIATE 串行化），非多进程压测；最后超管不变量两种合法交错均断言。
3. DEF-02 修复前，浏览器证据脚本在 S10 前显式等待首个视图就绪以规避竞态（脚本内注释标明）；正常操作节奏的证据有效。
4. 窄屏验证为 375px 单点（≥360px 要求）；表格横滚属设计适配。
5. 未做多浏览器矩阵（仅 Chrome）；Firefox/Safari 未覆盖。
6. 迁移演练基于 v001 旧库副本（研发构造基线），未接触任何现行服务数据文件。

## 6. 结论

- 40 条验收标准：37 条通过、1 条不通过（AC-12，DEF-01）、2 条归发布节点（AC-36/AC-40）；另有 DEF-02 前端竞态缺陷（AC-01~AC-04 正常节奏通过，竞态场景不成立）。
- **当前版本不可发布**：待研发修复 DEF-01/DEF-02 后由 regression 节点复测关闭（回归用例已就绪：IND-06 与 def-02 复现脚本转绿即闭环）。
