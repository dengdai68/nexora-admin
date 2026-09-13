# NEXORA-RBAC-011 测试用例设计

> 依据需求基线 `AC-01~AC-40`（docs/requirements/NEXORA-RBAC-011-requirements.md，trace 交付）逐条设计。
> 覆盖形态四档：**U**=单元（tests/unit）、**E**=真实 HTTP e2e（tests/e2e，研发交付）、**I**=测试工程师独立 e2e（tests/e2e/independent-verify.test.mjs，断言独立编写）、**B**=真实浏览器（tests/browser/cdp-evidence.mjs，Google Chrome CDP）。
> 全部自动化用例仅使用隔离临时 SQLite 与虚构用户（NFR-05）。

## A. 页面与导航

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-A-01 | AC-01 | super_admin 登录后导航呈现用户管理/角色管理/权限目录/授权审计四中文入口并可进入 | B（S3 截图 03） |
| TC-A-02 | AC-02 | 部分权限用户仅见获准入口（web_user 见 2/4 入口）；无权限直达视图呈「无权限」态；底层 API 实测 403 | B（S8/S9 截图 08/09）、E（frontend-admin-dom）、I（IND-02） |
| TC-A-03 | AC-03 | 列表分页/搜索齐全；加载中/空/失败/无权限四态文案可读 | E（frontend-admin-dom 四态）、I（IND-14 分页边界）、B（分页器入镜） |
| TC-A-04 | AC-04 | 375px 窄屏导航横排可达、表格横滚适配、关键操作可达 | B（S11 截图 11） |

## B. RBAC 模型

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-B-01 | AC-05 | 双角色并集精确等于两角色权限排序去重；并集内 200、并集外 403 | I（IND-13）、U（rbac-authz） |
| TC-B-02 | AC-06 | 禁用角色 R 后持有者下一请求失去 R 贡献权限；其他启用角色覆盖不受影响；重新启用即时恢复 | I（IND-01/IND-13）、U（rbac-authz） |
| TC-B-03 | AC-07 | 新注册响应仅 `{user:{username}}` 无角色字段；直调管理 API 403；`/api/me/permissions` 为空数组 | I（IND-01）、E（admin-access） |
| TC-B-04 | AC-08 | 提交目录外 key（含伪造 `ghost:hack`）→ 整体 400 且列出未知清单；默认拒绝成立 | I（IND-09）、E（admin-roles） |

## C. 角色管理

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-C-01 | AC-09 | 角色列表/搜索/分页/详情/新建/编辑/启停全流程持久化 | E（admin-roles）、B（S4 建角色） |
| TC-C-02 | AC-10 | key 重复 → 409 role_key_taken 不写入 | I（IND-10）、E（admin-roles） |
| TC-C-03 | AC-11 | 删除绑定中角色 → 409 role_in_use 含数量与示例用户名；角色保留；解绑后可删 | I（IND-10）、E（admin-roles） |
| TC-C-04 | AC-12 | super_admin 编辑/删除/禁用/改权限（含直接 API）→ 403 role_protected 并留审计 | I（IND-06，**暴露 DEF-01**：保留 key 改名路径 400 且无审计） |

## D. 权限目录

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-D-01 | AC-13 | 目录按四模块分组，每项含 key/名称/说明/关联页面与 API；只读可搜索 | E（admin-access）、B（目录页入镜） |
| TC-D-02 | AC-14 | 目录 key ⇄ 受保护路由双向相等，无虚假权限；分组节点不作守卫 | U（rbac-consistency） |

## E. 角色授权树

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-E-01 | AC-15 | 勾选父级联动子级；部分勾选父级半选（indeterminate=true）；取消同理 | U（rbac-tree-state）、E（frontend-admin-dom）、B（S5 截图 05） |
| TC-E-02 | AC-16 | 全选全部/取消全选作用于整个目录；已选计数实时准确；组节点不隐含授予 | U（rbac-tree-state）、B（S5 计数 4） |
| TC-E-03 | AC-17 | 搜索态「全选当前结果」只操作可见匹配并保留筛选外已选；与「全选全部」范围不混淆 | U（rbac-tree-state）、E（frontend-admin-dom） |
| TC-E-04 | AC-18 | 保存后重建回显与数据库一致（浏览器内服务端核对）；取消不产生改动 | B（S6 截图 06）、U（rbac-tree-state） |
| TC-E-05 | AC-19 | 未知/重复/非法结构整体 400 无部分成功；合法提交原子替换（权限集精确等于提交集） | I（IND-09）、E（admin-roles） |

## F. 用户授权

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-F-01 | AC-20 | 用户列表/详情展示已绑角色徽标与启用状态 | B（S7/截图 07/08）、E（admin-users） |
| TC-F-02 | AC-21 | 多角色分配/撤销、全选/取消全选、回显、保存原子化；未知/禁用角色新增整体 400 | B（S7 服务端核对）、E（admin-users）、U（rbac-validation） |
| TC-F-03 | AC-22 | 禁用后旧会话 401（/api/me 与 /api/resource）；启用不复活；禁用登录与密码错误/用户不存在逐字节一致 | I（IND-08）、U（rbac-authz） |
| TC-F-04 | AC-23 | 解绑角色/禁用角色后同一 session 下一请求即 403，无需重新登录 | I（IND-01/IND-13）、B（S9）、E（admin-users） |

## G. 服务端鉴权

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-G-01 | AC-24 | 14 端点未登录 401 unauthorized、已登录无权限 403 forbidden，语义不混用 | I（IND-02 全端点矩阵）、E（admin-access） |
| TC-G-02 | AC-25 | 请求体/头伪造角色、权限、操作者字段被忽略；审计操作者只来自会话 | I（IND-04）、E（admin-users） |

## H. 防提权与自锁

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-H-01 | AC-26 | 非超管分配/撤销 super_admin 绑定 → 403 super_admin_required + 审计 | I（IND-06）、E（admin-users） |
| TC-H-02 | AC-27 | 普通授权者勾选超自身权限/分配超自身权限角色 → 403 grant_out_of_scope 列越权 key + 审计；被拒后权限集不变 | I（IND-05）、E（admin-roles/admin-users） |
| TC-H-03 | AC-28 | 仅剩一名启用超管：禁用/撤权 409 last_super_admin；并发互相禁用至多一单成功且系统始终 ≥1 启用超管（合法交错 [200,409]/[200,401]） | I（IND-07）、E（admin-users 并发） |
| TC-H-04 | AC-29 | 普通授权者修改 super_admin 角色权限集或绑定 → 403 + 审计；即使超管操作者本体亦 403 role_protected | I（IND-06）、E（admin-roles） |

## I. CSRF / 注入 / 审计

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-I-01 | AC-30 | 7 个写端点缺失/错误 X-Nexora-CSRF 头 → 403 csrf_protection（会话与权限合法亦拒）；读端点不要求 | I（IND-03）、E（admin-roles） |
| TC-I-02 | AC-31 | LIKE 通配符 `%` 按字面不匹配全表；`' OR '1'='1` 无数据泄露；XSS 载荷角色名以纯文本存取；页面只落文本节点（零 innerHTML 静态扫描） | I（IND-11）、E（rbac-closure/frontend-admin-dom） |
| TC-I-03 | AC-32 | 审计字段完整（操作者/对象/时间/动作/前后差异/结果/原因）；成功与被拒绝均留痕；五维筛选+分页；非法筛选 400；输出不含密码/token/Cookie | I（IND-04/05/12）、U（rbac-audit）、B（S10 截图 10） |

## J. 迁移与引导

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-J-01 | AC-33 | v001 旧库（旧用户+旧会话）升级：数据完整、旧用户可登录、旧会话有效、迁移幂等 | E（rbac-upgrade）、U（migrations-rbac） |
| TC-J-02 | AC-34 | 迁移后 user_roles 为空，无任何账号自动获得 super_admin | E（rbac-upgrade）、U（migrations-rbac/migrations-seed） |
| TC-J-03 | AC-35 | 引导 CLI 四路径（用法错 2/账号不存在 1 不创建不涉密码/成功 0 写审计/幂等 0 不重复写审计）；脚本零明文密码静态红线；真实子进程验证 | E（bootstrap-cli）、U（rbac-bootstrap）、B（准备步真实 CLI 退出码 0） |
| TC-J-04 | AC-36 | 升级备份/迁移输出/回退方案记录 → 归发布节点发布报告 | 发布节点承接 |

## K. 既有功能回归

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-K-01 | AC-37 | 注册/登录/幂等注销/me/resource/health 契约不变：/api/me 响应键冻结、24h 绝对过期、dummy 防枚举、Cookie 属性、health version 注入 SHA；415/404/405 行为与 main 基线一致 | I（IND-15）、E（auth-flow/sessions/boundary/health）、U（既有 31 项） |

## L. 交付流程

| 用例 | 验收标准 | 场景与预期 | 形态 |
| --- | --- | --- | --- |
| TC-L-01 | AC-38 | 研发分支 SHA 与远程一致、main 未直推 | 测试报告 §1 实测核对 |
| TC-L-02 | AC-39 | 本报告含 tested SHA/工作区状态/真实命令输出/AC 逐条覆盖；关键授权流程真实浏览器证据；隔离临时库 | 本报告 + docs/testing/evidence/ |
| TC-L-03 | AC-40 | 合并 main、4322 部署、health 一致 → 归发布节点 | 发布节点承接 |

## 测试工程师独立新增用例索引（IND-01~IND-15）

`tests/e2e/independent-verify.test.mjs`：F-01 闭环（IND-01）、401/403 全端点矩阵（IND-02）、CSRF 全写端点（IND-03）、伪造字段（IND-04）、授权子集（IND-05）、super_admin 保护矩阵（IND-06，**DEF-01 复现**）、最后超管并发（IND-07）、禁用双保险（IND-08）、原子替换与未知输入（IND-09）、角色冲突（IND-10）、注入防线（IND-11）、审计五维（IND-12）、多角色并集（IND-13）、分页边界（IND-14）、冻结契约（IND-15）。

## 真实浏览器用例索引（S1~S11 + DEF-02 复现）

`tests/browser/cdp-evidence.mjs`：登录页（S1）→admin 登录（S2）→四入口导航（S3）→建角色（S4）→权限树父子联动/半选/计数（S5）→保存回显服务端核对（S6）→用户授权保存服务端核对（S7）→受限导航（S8）→撤权无权限态+底层 403（S9）→审计留痕检索（S10）→375px 窄屏（S11）。
`tests/browser/def-02-view-race-repro.mjs`：DEF-02 视图切换竞态确定性复现（Fetch 域挂起慢响应）。

## 开放缺陷（详见 docs/testing/defects/）

| 编号 | 标题 | 严重度 | 关联用例 |
| --- | --- | --- | --- |
| DEF-01 | super_admin 保留 key 改名返回 400 invalid_params 而非 403 role_protected，且该拒绝不留审计 | medium | TC-C-04（IND-06） |
| DEF-02 | 管理壳视图切换无并发防护：慢响应晚到覆盖当前视图，hash/导航高亮与内容不一致 | medium | 浏览器 S10（复现脚本 + 截图） |
