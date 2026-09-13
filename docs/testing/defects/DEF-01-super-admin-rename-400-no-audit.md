# DEF-01：super_admin 保留 key 改名返回 400 而非 403 role_protected，且该拒绝不留审计

| 项 | 值 |
| --- | --- |
| 编号 | DEF-01（NEXORA-RBAC-011） |
| 状态 | 开放 |
| 严重度 | medium |
| 发现人 | Nexora · 测试工程师（testing 节点） |
| 发现日期 | 2026-09-14 |
| 被测版本 | `0e7915bcb0de1581751219651793079a1d49ee77`（feat/nexora-rbac-011-rbac） |
| 关联验收 | AC-12（对 super_admin 的普通编辑/删除/禁用含直接 API 调用 → 403 并留审计）；契约 `docs/api.md` PUT /api/admin/roles/:id「super_admin 角色 → 403 role_protected（任何操作者）」 |
| 关联用例 | TC-C-04 / IND-06（tests/e2e/independent-verify.test.mjs，当前红色即为复现） |

## 描述

对内置 super_admin 角色执行「保留 key 仅改名」的普通编辑（最直接的直连编辑尝试），服务端返回 `400 invalid_params`（key 保留字校验），而非契约规定的 `403 role_protected`；且该被拒绝的编辑尝试**不写入审计**（400 结构错误按 DEV-D3 不落审计）。

保护本身有效：角色未被修改、无越权；改 key 为合法非保留字的编辑与启停/删除/改权限路径均正确返回 403 role_protected 并留审计。问题仅在「校验顺序 + 审计口径」组合：保留字校验（路由层结构校验）先于内置角色保护（服务层）执行，导致针对 super_admin 的改名尝试永远落在 400 路径，既不满足契约状态码，也使针对最高权限角色的编辑企图在审计中不可见。

## 复现步骤（真实命令与输出）

```bash
node --input-type=module -e "
import { startTestServer } from './tests/e2e/server-harness.mjs';
import { registerBootstrapLogin, writeCall } from './tests/e2e/admin-helpers.mjs';
const server = await startTestServer();
const admin = await registerBootstrapLogin(server, 'repro_admin', 'Passw0rd!123');
const roles = (await admin.request('/api/admin/roles?q=super_admin')).body.items;
const superRole = roles.find((r) => r.key === 'super_admin');
const a = await writeCall(admin, \`/api/admin/roles/\${superRole.id}\`, { method: 'PUT', body: { name: '改名尝试', key: 'super_admin', description: '' } });
console.log('A 改名保留key →', a.status, a.rawBody);
const b = await writeCall(admin, \`/api/admin/roles/\${superRole.id}\`, { method: 'PUT', body: { name: '改名尝试', key: 'super_admin_x', description: '' } });
console.log('B 改key合法载荷 →', b.status, b.rawBody);
const audit = await admin.request('/api/admin/audit-events?action=role.update&result=denied&pageSize=50');
console.log('role.update denied 审计条数 =', audit.body.items.length);
await server.close();
"
```

实际输出（2026-09-14 实测）：

```text
super_admin role id = 1
A 改名保留key → 400 {"error":{"code":"invalid_params","message":"参数不合法","fields":{"key":"该标识为内置保留字，不可使用"}}}
B 改key合法载荷 → 403 {"error":{"code":"role_protected","message":"内置超级管理员角色受保护，不可编辑"}}
role.update denied 审计条数 = 1   ← 仅路径 B 留痕，路径 A 无审计
尝试后 super_admin 名称 = 超级管理员（未被修改）
```

自动化复现：`node --test tests/e2e/independent-verify.test.mjs` 中 IND-06 当前失败于该断言。

## 期望行为

`PUT /api/admin/roles/:id`（目标为内置 super_admin）无论载荷如何，应先返回 `403 role_protected` 并按 AD-11 写 denied 审计（reason=role_protected）。建议：updateRole 路由/服务层在载荷校验前先按路径 id 解析目标并执行 isBuiltin 保护判定（路径寻址不依赖请求体，语义上也应优先）。

## 影响

- 契约一致性：AC-12 对「普通编辑」路径不成立（状态码偏离冻结契约）。
- 可审计性：针对最高权限角色的编辑企图可无审计留痕（探测不可见）。
- 无直接越权/数据破坏：所有路径均被拒绝，角色状态不变。
