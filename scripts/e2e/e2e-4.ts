/**
 * scripts/e2e/e2e-4.ts — E2E-4 权限控制（Case 4，DOD §9）。
 *
 * 降级方案（DOD 2026-07-02 决定）：真实飞书双账号暂缓——API 层双身份对照，协议层判定全量验证。
 * 身份来源：WATT_TOKEN（admin）+ WATT_EMPLOYEE_TOKEN（roles=['staff']，经
 *   `sign-admin-token.mjs --rotate --extra user:staff=staff` 同轮换签发）。缺 employee token →
 *   exit 2（前置缺失）。
 *
 * 判据：① admin 请求 → 财务工具被调用、正常回答（tool call 200 + 上游返回）；② employee →
 *   Authorizer deny（403 permission_denied）、工具零调用、`tool ls` 不可见（裁剪）；③ 两条
 *   AuditLog decision 分别 allow/deny 且主体正确。
 * 降级口径声明（C10）：DOD 已降级为"API 模拟两身份+协议层判定全量验证"——本脚本走 PEP 直测
 *   （tool call 200/403 + ls 裁剪 + audit 对照）；"工具零调用"由 403 发生在代理层 Check（上游
 *   不被触达，tools-proxy 测试锁定）保证；"礼貌拒绝"的 IM 文案面属 agent 对话链路（E2E-3 的
 *   lurker deny 路径已覆盖 agent 侧 rejected 语义）。
 *
 * 运行：TOKENS=$(node scripts/sign-admin-token.mjs --rotate --extra user:staff=staff)
 *       WATT_TOKEN=$(sed -n 1p <<<"$TOKENS") WATT_EMPLOYEE_TOKEN=$(sed -n 2p <<<"$TOKENS") \\
 *       node scripts/e2e/e2e-4.ts
 */

import { assert, cli, type E2eEnv, loadEnv, runE2e, stepLog, waitFor } from './lib.ts';

interface AuditRow {
  resource: string;
  action: string;
  decision: string;
  at: string;
  context: { principal: string };
}

const TOOL_PATH = 'finance/e2e4';
const POLICY_ID = 'e2e4-admin-finance';

await runE2e('e2e-4', async () => {
  const env = loadEnv();
  const log = stepLog('e2e-4');
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const employeeToken = process.env.WATT_EMPLOYEE_TOKEN?.trim() ?? '';
  if (employeeToken.length === 0) {
    console.error(
      'e2e-4: WATT_EMPLOYEE_TOKEN is not set — sign both via ' +
        'scripts/sign-admin-token.mjs --rotate --extra user:staff=staff',
    );
    process.exit(2);
  }
  const employeeEnv: E2eEnv = { ...env, token: employeeToken };

  // 前置：桩财务工具（http provider，postman-echo 回显即"正常回答"）+ admin allow 策略。
  // 种子 admin 已有 platform://* 面；tool:// 树按需授权——admin 显式 allow，staff 无策略=默认 deny。
  cli(env, [
    'tool',
    'mount',
    TOOL_PATH,
    '--provider',
    'http',
    '--config',
    JSON.stringify({
      endpoints: [
        {
          name: 'report',
          method: 'GET',
          url: 'https://postman-echo.com/get',
          description: 'quarterly finance report (stub)',
        },
      ],
    }),
  ]);
  cli(env, [
    'policy',
    'add',
    '--id',
    POLICY_ID,
    '--subject',
    'role:admin',
    '--resource',
    `tool://${TOOL_PATH}/*`,
    '--actions',
    'invoke,read',
    '--effect',
    'allow',
  ]);

  // ① admin：tool call 200 + 上游正常回答。
  const adminResult = await waitFor('admin tool call succeeds (edge propagation)', () => {
    try {
      return cli<Record<string, unknown>>(env, [
        'tool',
        'call',
        TOOL_PATH,
        'report',
        '--args',
        '{}',
      ]);
    } catch {
      return undefined;
    }
  });
  assert(
    adminResult !== undefined && typeof adminResult === 'object',
    'admin call should return a result object',
  );
  log.pass(
    '① admin request → tool invoked, normal answer',
    JSON.stringify(adminResult).slice(0, 80),
  );

  // ② employee：403 permission_denied + 零调用 + ls 不可见。
  let employeeDenied = false;
  try {
    cli(employeeEnv, ['tool', 'call', TOOL_PATH, 'report', '--args', '{}']);
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    assert(
      msg.includes('403') || msg.includes('permission_denied'),
      `employee call should be 403 permission_denied, got: ${msg.slice(0, 150)}`,
    );
    employeeDenied = true;
  }
  assert(employeeDenied, 'employee tool call should have been denied');
  // ls 裁剪：employee 看不到 finance 树。
  let employeeSees = false;
  try {
    const ls = cli<{ path: string }[]>(employeeEnv, ['tool', 'ls']);
    employeeSees = (Array.isArray(ls) ? ls : []).some((t) => t.path === TOOL_PATH);
  } catch {
    employeeSees = false; // ls 整体拒绝也算不可见
  }
  assert(!employeeSees, 'employee tool ls should not reveal the finance tool');
  log.pass('② employee request → deny (403), tool invisible in ls');

  // ③ audit：allow（admin）与 deny（staff）各一条，主体正确，chain 完整（user token 无 agent 链）。
  const audit = cli<{ items: AuditRow[] }>(env, ['audit', 'list']);
  const recent = audit.items.filter(
    (r) => r.at >= startedAt && r.resource.startsWith(`tool://${TOOL_PATH}`),
  );
  const allowRec = recent.find((r) => r.decision === 'allow' && r.action === 'invoke');
  const denyRec = recent.find((r) => r.decision === 'deny' && r.action === 'invoke');
  assert(allowRec !== undefined, 'audit should contain the admin allow decision');
  assert(denyRec !== undefined, 'audit should contain the employee deny decision');
  assert(
    denyRec.context.principal === 'user:staff',
    `deny principal should be user:staff, got ${denyRec.context.principal}`,
  );
  // chain 完整性（user token 面）：直调无 agent 链——audit context 不带 agent 段即为正确链形状
  //   （agent 委托链的 chain 断言由 lurker/scheduler 审计用例覆盖）。
  const denyCtx = denyRec.context as { principal: string; agent?: { chain?: string[] } };
  assert(denyCtx.agent === undefined, 'user-token deny should carry no agent chain (direct call)');
  log.pass(
    '③ audit decisions allow/deny with correct principals',
    `allow=${allowRec.context.principal} deny=${denyRec.context.principal}`,
  );

  // 清理：策略与工具挂载（unmount 动词 = tool mount 无 rm——Update enabled:false 兜底）。
  cli(env, ['policy', 'rm', POLICY_ID]);
  log.pass('cleanup', 'policy removed (tool mount left enabled=true, idempotent upsert)');
});
