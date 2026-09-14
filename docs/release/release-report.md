# NEXORA-RBAC-011 发布报告（release 节点）

## 0. 元信息

| 项 | 值 |
| --- | --- |
| 需求编号 | NEXORA-RBAC-011（角色、权限、授权与完整权限管理，重新执行） |
| 节点 | release（主分支合并与本地发布部署） |
| 负责人 | Nexora · 发布部署工程师（agent_mtzhloot_1） |
| 日期 | 2026-09-14 |
| 状态 | ✅ **发布完成，待人类验收** |
| 仓库 | `repos/nexora-admin`，remote = `https://github.com/dengdai68/nexora-admin.git` |
| 需求分支 | `feat/nexora-rbac-011-rbac`，HEAD = `ba3ea6f38f21d99d426134d57a2bd10a687ab45a` |
| tested SHA（回归） | `0e7918d71b0ba19a97d86150af26dc0a1dadfe29`（regression 提交对产品代码零差异，待发布产品代码即此版本） |
| **合并提交（发布版本）** | **`87f346b49f291a9b51a5171c8184ea6cd181313e`** |
| 本地 main HEAD | `87f346b49f291a9b51a5171c8184ea6cd181313e` |
| 远程 main（ls-remote 核对） | `87f346b49f291a9b51a5171c8184ea6cd181313e`（一致；合并前为 `66f5854b54b60eebb1b3f840ac24ca0b6aa9e5cd`） |
| 部署 URL | http://127.0.0.1:4322 |
| 服务进程 | PID **91253**（PPID=1，已脱离 Agent 进程常驻） |
| 数据库 | 现行服务库（NEXORA_DB_PATH 指向既有运行库，升级不清库、旧数据全保留） |
| 执行环境 | macOS Darwin 25.4.0（arm64）、Node v24.7.0、零 npm 外部依赖 |

## 1. 输入核验（发布质量门）

| 质量门 | 证据 | 结论 |
| --- | --- | --- |
| 测试通过结论 | `docs/regression/regression-report.md`：明确「测试通过，可发布」，tested SHA = `0e7918d`，unit 69/69、e2e 78/78（含独立验证 IND-01~15）连续 3 次全绿，真实浏览器 14 步连续 3 次通过 | ✅ |
| 零开放缺陷 | DEF-01（defect_mu08kgcn_y2）、DEF-02（defect_mu08kgcn_y3）均「已验证关闭」；开放 Defect = 0 | ✅ |
| tested SHA = 待发布产品代码 | 发布节点实测 `git diff 0e7918d ba3ea6f -- server web package.json package-lock.json` 为空（regression 提交仅测试/文档/证据） | ✅ |
| 基线未漂移 | 合并前 `git ls-remote origin main` = `66f5854`（与全链路锚点一致，未被他人推进），工作区干净 | ✅ |
| AC 归口 | AC-36（备份/回退记录）、AC-40（合并部署 4322、health 一致）由本节点承接，见 §4/§5/§6 | ✅ |

## 2. 合并与推送（真实命令与结果）

```text
$ git checkout main                       # 66f5854，工作区干净
$ git merge --no-ff feat/nexora-rbac-011-rbac
Merge made by the 'ort' strategy.         # 68 文件 +7884/-78，保留全部历史
$ git rev-parse HEAD
87f346b49f291a9b51a5171c8184ea6cd181313e
```

合并提交上重跑全量套件（发布回归，真实输出）：

```text
$ npm test            # tests 69 / pass 69 / fail 0
$ npm run test:e2e    # tests 78 / pass 78 / fail 0
```

推送与远程核对：

```text
$ git push origin main
   66f5854..87f346b  main -> main
$ git ls-remote origin main
87f346b49f291a9b51a5171c8184ea6cd181313e  refs/heads/main   # = 本地 HEAD，一致
```

本报告为合并后的纯文档归档提交；提交后远程 main 将再次核对（见 §8 交付摘要口径：报告提交仅追加 `docs/release/`，不触碰任何产品/测试代码）。

## 3. 部署执行（127.0.0.1:4322）

### 3.1 旧服务处置

- 端口检查：`lsof -iTCP:4322` → PID 22433，`node server/index.mjs`，cwd 为既有项目工作区（nexora-e2e-008.AoWknQ），`APP_COMMIT_SHA=66f5854`（上一需求合并版本），**确认属本 Nexora 项目旧服务**。
- 优雅停止：`kill -TERM 22433` → 进程退出、端口释放（服务端 SIGTERM 优雅退出路径实测生效）。
- 未触碰任何无关进程；AgentForge 4310 未触碰。

### 3.2 升级前备份（AC-36）

- 旧服务优雅退出后 WAL 已归档，备份为完整一致单文件库：
  `data/backups/pre-rbac011-20260914-050727/nexora.db`（位于现行库 data 目录下，与库同源留存）。
- 迁移前基线（只读实测）：schema_migrations = v1；users = 8；sessions = 8（8 条均已撤销态——对备份库实测确认系既有 QA 账号早前注销所致，非迁移行为）；无 `admin` 账号。

### 3.3 启动合并版本（脱离短命 Agent 进程）

```bash
cd repos/nexora-admin
NEXORA_HOST=127.0.0.1 NEXORA_PORT=4322 \
NEXORA_DB_PATH="<现行服务库路径>" \
APP_COMMIT_SHA=87f346b49f291a9b51a5171c8184ea6cd181313e \
nohup node server/index.mjs > logs/release-4322.log 2>&1 &
```

| 项 | 值 |
| --- | --- |
| PID | **91253**（`ps` 实测 PPID=1，已脱离终端常驻） |
| 启动日志 | `repos/nexora-admin/logs/release-4322.log`（gitignore，运行期产物） |
| 停止方式 | `kill -TERM 91253`（优雅退出） |
| 启动方式（重启） | 上述 nohup 命令原样重执行 |

启动时迁移自动幂等执行：schema v1 → v2 → v3 各应用一次；随后两次引导脚本执行均复用同一迁移入口无重复应用（可重复迁移在现行库实测成立）。**绝不清库。**

### 3.4 健康检查（AC-40）

```text
$ curl -s http://127.0.0.1:4322/api/health
{"status":"ok","version":"87f346b49f291a9b51a5171c8184ea6cd181313e"}   HTTP=200
```

health 返回 version = 合并提交 SHA，一致 ✅。前端页面 `GET /` 200（云枢后台中文登录页）。

### 3.5 数据保留与零静默提权（迁移后只读实测）

| 检查 | 迁移前 | 迁移后 | 结论 |
| --- | --- | --- | --- |
| users | 8 | 8（status 全部回填 active） | ✅ 保留 |
| sessions | 8（均撤销态） | 8（一致） | ✅ 保留，迁移未动会话 |
| RBAC 种子 | — | super_admin 内置角色 ×1、权限目录 ×10、super_admin 权限 ×10 | ✅ |
| user_roles | — | **0**（升级未绑定任何用户，零静默提权） | ✅ |

### 3.6 注册/登录/权限冒烟（真实输出摘要）

| 步骤 | 结果 |
| --- | --- |
| 注册虚构用户 `release_rbac011_051245` | 201 |
| 登录 | 200，下发会话 Cookie |
| `GET /api/me` | 200 |
| `GET /api/me/permissions` | `{"permissions":[]}`（新用户默认无后台权限） |
| 未登录直调 `GET /api/admin/users` | **401** unauthorized |
| 普通用户直调 `GET /api/admin/users` | **403** forbidden（默认拒绝） |
| 注销 | 200（幂等） |
| 注销后 `GET /api/me` | 401（会话已撤销） |

冒烟用户为虚构账号、已注销，沿用历次发布在本机服务留冒烟账号的惯例；自动化测试套件仍全部使用隔离临时 SQLite。

## 4. 首位管理员引导（AC-35/AC-39 口径落地）

1. 首次执行 `npm run bootstrap:admin -- --username admin` → **按设计保护性失败**：退出码 1，`账号 admin 不存在：请先通过注册接口创建该账号；本脚本不创建账号、不处理密码`（证实迁移不自动提权、引导不擅自建号）。
2. 发布节点就「D-01 确认的 admin 账号在现行库不存在」咨询人类（clarification_question）；人类答复（2026-09-14T00:33:29Z）：**由发布方直接建号，无需人类手动注册**。
3. 按人类指示：生成一次性强随机口令 → 经公开注册接口创建 `admin`（201，应用的 scrypt 哈希入库，凭据不经文档/代码）→ 再次执行引导：
   `已将账号 admin 授予超级管理员（super_admin），审计已记录`，退出码 0。
4. 幂等复跑：`账号 admin 已是超级管理员（幂等，无变更）`，退出码 0，审计不重复（仍 1 条）。
5. 引导后实测：admin 登录 200；`/api/me/permissions` 返回目录全部 10 项；`GET /api/admin/users` 200（total=10）；审计表留痕 `admin.bootstrap`（actor=`system:bootstrap`，target=user/admin，result=success，detail.after.role=super_admin）；user_roles 绑定 admin→super_admin（内置角色）。
6. **凭据处置**：一次性口令仅在交付消息中告知人类，不写入本报告/代码/任何文档；审计与日志均不含凭据（detail 键白名单 + 日志脱敏由既有实现保证）。

## 5. 回退方案（AC-36）

1. `kill -TERM 91253` 停止本服务；
2. 以备份覆盖现行库：`cp data/backups/pre-rbac011-20260914-050727/nexora.db <现行库路径>`（备份为 WAL 归档后的完整单文件库）；
3. 重启旧版本：既有项目工作区代码仍停留在 `66f5854` 且未做任何改动，按原方式 `APP_COMMIT_SHA=66f5854… npm start` 即可恢复上一需求版本；
4. 回退后状态 = 升级前完全一致（旧用户/旧会话/旧 schema v1）。RBAC 数据仅存在于迁移后的库中，随备份恢复一并移除。

## 6. 风险与限制（如实声明）

1. 服务从本次 Run 检出目录（/tmp 下）以 nohup 常驻运行，供人类验收；机器重启或系统清理 /tmp 后需按 §3.3 原命令重启（长期部署可在任意稳定位置检出 main 后同法启动）。
2. 真实浏览器证据由测试/回归节点提供（Chrome 152 headless=new CDP 整页截图 12+ 张、`evidence-log.json` 记录 commitSha=0e7918d），本节点未重复执行浏览器流程；发布节点核验为 health/API/数据库级真实命令。
3. 并发验证为单进程事件循环交错（BEGIN IMMEDIATE 串行化），非多进程压测（沿用回归报告口径）。
4. admin 口令为一次性随机生成、仅交付消息告知；系统本期不含改密功能（任务书明确不做），如需轮换须由后续需求实现。
5. 现行库中新增两个虚构账号：`admin`（人类指示设立的首位超管）与 `release_rbac011_051245`（发布冒烟，已注销）；旧 8 账号与其会话零改动。

## 7. 人类验收步骤

1. 浏览器打开 http://127.0.0.1:4322 ，以交付消息中提供的 admin 凭据登录；
2. 登录后应见四个中文后台入口：用户管理 / 角色管理 / 权限目录 / 授权审计；
3. 权限目录：10 项权限按模块分组只读展示；用户管理：admin 显示「超级管理员」角色、共 10 个用户；授权审计：可检索到 `admin.bootstrap` 记录；
4.（可选端到端复核）角色管理新建角色→权限树勾选保存→用户管理给某虚构用户绑定该角色→该用户登录仅见获准入口→撤销角色后其下一次请求 403；
5. 健康核对：`curl -s http://127.0.0.1:4322/api/health` 返回 version = `87f346b49f291a9b51a5171c8184ea6cd181313e`；
6. 服务停止：`kill -TERM 91253`；回退见 §5。

## 8. 证据索引

- 需求/架构/开发/测试/回归：`docs/architecture.md`、`docs/api.md`、`docs/testing/test-report.md`、`docs/testing/test-cases.md`、`docs/regression/regression-report.md`、缺陷单 `docs/testing/defects/`（均已随合并进入 main）。
- 本节点真实命令输出已摘入 §2~§5；服务运行日志 `logs/release-4322.log`；数据库备份 `data/backups/pre-rbac011-20260914-050727/`。
