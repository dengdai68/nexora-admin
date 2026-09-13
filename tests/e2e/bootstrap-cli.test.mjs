/**
 * e2e：引导 CLI 真实进程测试（NEXORA-RBAC-011 / AC-35）：
 * 以子进程真实执行 server/bootstrap-admin.mjs（NEXORA_DB_PATH 指向隔离临时库），断言退出码与输出：
 * 参数错误 → 2；账号不存在 → 1（不创建账号）；成功授权 → 0 且写审计；重复执行 → 0 幂等（不重复写审计）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openMigratedDatabase } from '../../server/migrations.mjs';
import { insertUser } from '../../server/db.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../server/bootstrap-admin.mjs');

/** 运行 CLI，返回 {code, stdout, stderr}（不抛异常）。 */
async function runCli(dbPath, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, NEXORA_DB_PATH: dbPath },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('e2e(bootstrap-cli): 四路径真实进程验证（退出码 2/1/0/幂等 0）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nexora-bootstrap-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'cli.db');
  // 预置：已迁移库 + 虚构已注册用户（不经 CLI 创建账号）
  const db = openMigratedDatabase(dbPath);
  insertUser(db, { username: 'admin', passwordHash: 'scrypt:stub', createdAt: 1 });
  db.close();

  const badArgs = await runCli(dbPath, []);
  assert.equal(badArgs.code, 2, '缺参数退出码 2');
  assert.ok(badArgs.stderr.includes('用法'), '输出用法说明');
  const badArgs2 = await runCli(dbPath, ['--username']);
  assert.equal(badArgs2.code, 2);

  const noUser = await runCli(dbPath, ['--username', 'ghost_99']);
  assert.equal(noUser.code, 1, '账号不存在退出码 1');
  assert.ok(noUser.stderr.includes('不存在'), '明确报错');
  const checkDb = openMigratedDatabase(dbPath);
  assert.equal(Number(checkDb.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'ghost_99'").get().n), 0, '不创建账号');
  checkDb.close();

  const granted = await runCli(dbPath, ['--username', 'admin']);
  assert.equal(granted.code, 0, '成功授权退出码 0');
  assert.ok(granted.stdout.includes('授予超级管理员'));

  const again = await runCli(dbPath, ['--username', 'admin']);
  assert.equal(again.code, 0, '重复执行幂等退出码 0');
  assert.ok(again.stdout.includes('已是超级管理员'));

  const verify = openMigratedDatabase(dbPath);
  assert.equal(Number(verify.prepare('SELECT COUNT(*) AS n FROM user_roles').get().n), 1, '绑定行数为 1');
  assert.equal(
    Number(verify.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.bootstrap'").get().n),
    1,
    '审计仅一条（幂等不重复写）',
  );
  verify.close();
});

test('e2e(bootstrap-cli): CLI 不含任何明文密码（静态红线）', () => {
  const source = execFileSync('cat', [SCRIPT]).toString('utf8');
  for (const forbidden of ['password', 'Password', 'scrypt:']) {
    assert.ok(!source.includes(forbidden), `引导脚本不得出现 ${forbidden}`);
  }
});
