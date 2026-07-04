import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  agentGet,
  agentList,
  agentSend,
  agentSpawn,
  agentTerminate,
  agentTree,
  formatDefinitionListHuman,
  formatInstanceTreeHuman,
} from './agent.ts';
import { auditList, formatAuditListHuman } from './audit.ts';
import { channelList, channelSet, formatChannelListHuman } from './channel.ts';
import {
  credentialsPath,
  type FsDeps,
  requireBaseUrl,
  requireToken,
  resolveToken,
} from './client.ts';
import { connectFeishu, consoleLogger, runSupervisor } from './connect.ts';
import {
  contextGet,
  contextList,
  contextMount,
  contextPatch,
  contextPut,
  contextUnmount,
  formatEntryListHuman,
  parseMetadata,
} from './context.ts';
import {
  type CronJobInput,
  cronCreate,
  cronGet,
  cronList,
  cronRm,
  cronTrigger,
  formatCronListHuman,
} from './cron.ts';
import { CliError, readEnv } from './env.ts';
import { type EventView, eventGet, eventSubs, eventTail, formatEventLine } from './event.ts';
import { approveDevice, type DeviceAuthorizeResponse, login } from './login.ts';
import { formatMetricsHuman, metricsQuery } from './metrics.ts';
import {
  formatPluginHealthHuman,
  formatPluginListHuman,
  type PluginManifest,
  pluginHealth,
  pluginList,
  pluginRegister,
} from './plugin.ts';
import {
  formatPolicyListHuman,
  policyAdd,
  policyList,
  policyMapIdentity,
  policyRm,
} from './policy.ts';
import {
  formatProviderListHuman,
  providerAdd,
  providerList,
  providerSetDefault,
} from './provider.ts';
import { formatSecretListHuman, secretList, secretRm, secretSet } from './secret.ts';
import { formatSetupGuidance, setupFeishu } from './setup.ts';
import { fetchStatus, formatStatusHuman } from './status.ts';
import {
  formatDefinitionListHuman as formatTaskDefsHuman,
  formatTaskListHuman,
  taskCancel,
  taskDefs,
  taskGet,
  taskList,
  taskRun,
  taskSignal,
} from './task.ts';
import { formatMountListHuman, toolCall, toolDescribe, toolList, toolMount } from './tool.ts';
import { formatWhoamiHuman, whoami } from './whoami.ts';

/** commander 的可重复选项收集器（`--metadata k=v` 累积成数组）。 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

/** 解析 JSON 选项值（agent --input/--payload 等）；非法 → CliError(2)。 */
function parseJsonOpt(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${flag} must be valid JSON`, 2);
  }
}

/** 解析正整数选项（--ttl/--priority/--timeout-ms）；非法 → CliError(2)。 */
function parsePositiveInt(raw: string, flag: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`${flag} must be a positive integer`, 2);
  }
  return n;
}

/** 从 spawn/send 选项构造 ExpectSpec（--expect-schema / --correlation-id / --timeout-ms）；均缺 → undefined。 */
function buildExpect(cmdOpts: {
  expectSchema?: string;
  correlationId?: string;
  timeoutMs?: string;
}): { correlationId?: string; timeoutMs?: number; schema?: unknown } | undefined {
  const has =
    cmdOpts.expectSchema !== undefined ||
    cmdOpts.correlationId !== undefined ||
    cmdOpts.timeoutMs !== undefined;
  if (!has) return undefined;
  const expect: { correlationId?: string; timeoutMs?: number; schema?: unknown } = {};
  if (cmdOpts.correlationId !== undefined) expect.correlationId = cmdOpts.correlationId;
  if (cmdOpts.timeoutMs !== undefined)
    expect.timeoutMs = parsePositiveInt(cmdOpts.timeoutMs, '--timeout-ms');
  if (cmdOpts.expectSchema !== undefined) {
    expect.schema = parseJsonOpt(cmdOpts.expectSchema, '--expect-schema');
  }
  return expect;
}

/** 默认 stdin 读取（context put/patch 无 --content/--file 时用；测试注入 readStdin 覆盖）。 */
function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * 从 create 选项构造 CronAction（三型）——publish|agent|script。
 * 缺必填 → CliError(2)。JSON 选项非法 → CliError(2)（parseJsonOpt）。
 */
function buildCronAction(cmdOpts: {
  actionKind: string;
  eventType?: string;
  payload?: string;
  session?: string;
  definition?: string;
  input?: string;
  instanceBy?: string;
  scriptRef?: string;
  grants?: string;
}): Record<string, unknown> {
  switch (cmdOpts.actionKind) {
    case 'publish': {
      if (cmdOpts.eventType === undefined) {
        throw new CliError('--event-type is required for --action-kind publish', 2);
      }
      const event: Record<string, unknown> = { type: cmdOpts.eventType };
      if (cmdOpts.payload !== undefined) event.payload = parseJsonOpt(cmdOpts.payload, '--payload');
      if (cmdOpts.session !== undefined) event.session = cmdOpts.session;
      return { kind: 'publish', event };
    }
    case 'agent': {
      if (cmdOpts.definition === undefined) {
        throw new CliError('--definition is required for --action-kind agent', 2);
      }
      const action: Record<string, unknown> = { kind: 'agent', definition: cmdOpts.definition };
      if (cmdOpts.input !== undefined) action.input = parseJsonOpt(cmdOpts.input, '--input');
      if (cmdOpts.instanceBy !== undefined) {
        if (cmdOpts.instanceBy !== 'singleton' && cmdOpts.instanceBy !== 'event') {
          throw new CliError('--instance-by must be "singleton" or "event"', 2);
        }
        action.instanceBy = cmdOpts.instanceBy;
      }
      return action;
    }
    case 'script': {
      if (cmdOpts.scriptRef === undefined) {
        throw new CliError('--script-ref is required for --action-kind script', 2);
      }
      const grants = cmdOpts.grants !== undefined ? parseJsonOpt(cmdOpts.grants, '--grants') : [];
      return { kind: 'script', scriptRef: cmdOpts.scriptRef, grants };
    }
    default:
      throw new CliError('--action-kind must be "publish", "agent", or "script"', 2);
  }
}

export interface RunOptions {
  /** 输出流（默认 process.stdout/stderr），便于测试捕获。 */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  /** 文件系统注入（凭据读写），测试用。 */
  fs?: FsDeps;
  /** 凭据路径覆盖（测试用）。 */
  credentialsPath?: string;
  /** login 轮询 sleep 注入（测试即时返回）。 */
  sleep?: (ms: number) => Promise<void>;
  /** now() 注入（测试用）。 */
  now?: () => number;
  /** 环境变量注入（默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** stdin 读取注入（context put/patch 无 --content/--file 时从 stdin 读；测试用）。 */
  readStdin?: () => Promise<string>;
  /** 文件读取注入（context put/patch 的 --file；测试用）。 */
  readFile?: (path: string) => string;
}

/**
 * 构建并执行 CLI。返回进程退出码（不直接调用 process.exit，便于测试）。
 * `--json` 为全局开关：输出原始 JSON 而非人类可读文本。
 */
export async function run(argv: string[], opts: RunOptions = {}): Promise<number> {
  const out = opts.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = opts.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const credPath = opts.credentialsPath ?? credentialsPath();

  const program = new Command();
  program
    .name('watt')
    .description('Watt platform CLI (pure Platform API client, DOD M10)')
    .option('--json', 'output raw JSON instead of human-readable text', false)
    .exitOverride() // 抛错而非直接 process.exit，交由本函数统一处理退出码。
    .configureOutput({
      writeOut: (s) => out(s.replace(/\n$/, '')),
      writeErr: (s) => err(s.replace(/\n$/, '')),
    });

  const asJson = () => program.opts().json === true;
  const env = () => readEnv(opts.env);

  program
    .command('status')
    .description('GET <WATT_BASE_URL>/healthz + live metrics summary (instances/tasks/tokens)')
    .action(async () => {
      // token 可选：有 token 则附带实时指标汇总（DoD ③），无 token 仅 healthz。
      const token = resolveToken(env(), credPath, opts.fs);
      const result = await fetchStatus(env(), { fetch: opts.fetch }, token);
      if (asJson()) out(JSON.stringify(result));
      else out(formatStatusHuman(result));
    });

  program
    .command('login')
    .description('Authenticate via device flow (RFC 8628); admin approves the user code')
    .option('--approve <user_code>', 'admin: approve a pending device user code with your token')
    .option('--principal <principal>', 'admin: bind approval to this principal (default: yourself)')
    .action(async (cmdOpts: { approve?: string; principal?: string }) => {
      const base = requireBaseUrl(env());
      if (cmdOpts.approve) {
        const token = requireToken(env(), credPath, opts.fs);
        const result = await approveDevice(base, token, cmdOpts.approve, cmdOpts.principal, {
          fetch: opts.fetch,
        });
        if (asJson()) out(JSON.stringify(result));
        else out(`Approved user code ${cmdOpts.approve} → ${result.principal ?? ''}`);
        return;
      }
      const result = await login(base, (line) => (asJson() ? undefined : out(line)), {
        fetch: opts.fetch,
        sleep: opts.sleep,
        now: opts.now,
        fs: opts.fs,
        credentialsPath: credPath,
        onDeviceAuthorized: asJson()
          ? (auth: DeviceAuthorizeResponse) =>
              out(
                JSON.stringify({
                  user_code: auth.user_code,
                  verification_uri: auth.verification_uri,
                  expires_in: auth.expires_in,
                }),
              )
          : undefined,
      });
      if (asJson()) {
        out(
          JSON.stringify({
            access_token_prefix: `${result.access_token.slice(0, 8)}...`,
            token_type: result.token_type,
            expires_in: result.expires_in,
            saved_to: credPath,
          }),
        );
      } else {
        out(`Logged in. Credentials saved to ${credPath}`);
      }
    });

  program
    .command('whoami')
    .description('GET <WATT_BASE_URL>/htbp/platform/whoami and print principal/roles')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const result = await whoami(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(result));
      else out(formatWhoamiHuman(result));
    });

  const policy = program.command('policy').description('Manage authorization policies');
  policy
    .command('list')
    .description('List policies (platform://policy read)')
    .option('--subject <subject>', 'filter by subject')
    .action(async (cmdOpts: { subject?: string }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const policies = await policyList(
        base,
        token,
        { subject: cmdOpts.subject },
        {
          fetch: opts.fetch,
        },
      );
      if (asJson()) out(JSON.stringify(policies));
      else out(formatPolicyListHuman(policies));
    });
  policy
    .command('add')
    .description('Add a policy (platform://policy manage)')
    .requiredOption('--subject <subject>', 'e.g. user:alice | role:admin | *')
    .requiredOption('--resource <resource>', 'URI pattern, e.g. tool://finance/*')
    .requiredOption('--actions <actions>', 'comma-separated actions, e.g. read,invoke or *')
    .option('--effect <effect>', 'allow | deny', 'allow')
    .option('--id <id>', 'explicit policy id (default: generated)')
    .action(
      async (cmdOpts: {
        subject: string;
        resource: string;
        actions: string;
        effect: string;
        id?: string;
      }) => {
        if (cmdOpts.effect !== 'allow' && cmdOpts.effect !== 'deny') {
          throw new CliError('--effect must be "allow" or "deny"', 2);
        }
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const actions = cmdOpts.actions
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean);
        const created = await policyAdd(
          base,
          token,
          {
            id: cmdOpts.id,
            subject: cmdOpts.subject,
            resource: cmdOpts.resource,
            actions,
            effect: cmdOpts.effect,
          },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(created));
        else out(`Added policy ${created.id}`);
      },
    );
  policy
    .command('rm')
    .description('Remove a policy by id (platform://policy manage)')
    .argument('<id>', 'policy id')
    .action(async (id: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const result = await policyRm(base, token, id, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(result));
      else out(`Removed policy ${id}`);
    });
  policy
    .command('map')
    .description('Map a channel identity to a principal (IdentityMapper.Resolve, §6.3)')
    .requiredOption('--channel <channel>', 'e.g. feishu')
    .requiredOption('--channel-user-id <id>', 'channel-native user id, e.g. feishu open_id')
    .requiredOption('--principal <principal>', 'e.g. user:alice')
    .action(async (cmdOpts: { channel: string; channelUserId: string; principal: string }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const result = await policyMapIdentity(
        base,
        token,
        {
          channel: cmdOpts.channel,
          channelUserId: cmdOpts.channelUserId,
          principal: cmdOpts.principal,
        },
        { fetch: opts.fetch },
      );
      if (asJson()) out(JSON.stringify(result));
      else out(`Mapped ${result.channel}:${result.channelUserId} -> ${result.principal}`);
    });

  const audit = program.command('audit').description('Inspect the audit log');
  audit
    .command('list')
    .description('List audit records (platform://audit read; §10 AuditLog.List)')
    .option('--principal <principal>', 'filter by principal (exact)')
    .option('--agent <instanceId>', 'filter by agent instance id (exact)')
    .option('--resource <uri>', 'filter by resource URI (prefix)')
    .option('--decision <allow|deny>', 'filter by decision')
    .option('--limit <n>', 'max records (default 50, cap 200)')
    .action(
      async (cmdOpts: {
        principal?: string;
        agent?: string;
        resource?: string;
        decision?: string;
        limit?: string;
      }) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const result = await auditList(
          base,
          token,
          {
            principal: cmdOpts.principal,
            agent: cmdOpts.agent,
            resource: cmdOpts.resource,
            decision: cmdOpts.decision,
            ...(cmdOpts.limit !== undefined ? { limit: Number(cmdOpts.limit) } : {}),
          },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(result));
        else out(formatAuditListHuman(result));
      },
    );

  const metrics = program.command('metrics').description('Query platform metrics (§10 Metrics)');
  metrics
    .command('query')
    .description('Query a metric over a time range (tokens/tasks/events/agent_instances/...)')
    .requiredOption(
      '--metric <name>',
      'metric: tokens|cost|cache_hit_rate|agent_instances|tasks|events|tool_calls|authz_denials',
    )
    .option('--range <span>', 'relative range: 7d|24h|30m (default 7d)')
    .option('--from <iso8601>', 'explicit range start (overrides --range with --to)')
    .option('--to <iso8601>', 'explicit range end')
    .option('--group-by <dims>', 'comma-separated: provider,model,agent,channel,day,hour')
    .action(
      async (cmdOpts: {
        metric: string;
        range?: string;
        from?: string;
        to?: string;
        groupBy?: string;
      }) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const result = await metricsQuery(
          base,
          token,
          {
            metric: cmdOpts.metric,
            range: cmdOpts.range,
            from: cmdOpts.from,
            to: cmdOpts.to,
            ...(cmdOpts.groupBy !== undefined
              ? { groupBy: cmdOpts.groupBy.split(',').map((s) => s.trim()) }
              : {}),
          },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(result));
        else out(formatMetricsHuman(cmdOpts.metric, result));
      },
    );

  const event = program.command('event').description('Inspect the event stream (Event Gateway)');
  event
    .command('tail')
    .description('Poll EventStore.List and stream events (M10: tail = 轮询 List)')
    .option('--type <type>', 'filter by event type (exact match)')
    .option('--channel <channel>', 'filter by source channel')
    .option('--session <session>', 'filter by session')
    .option('--since <iso8601>', 'start cursor (inclusive occurredAt)')
    .option('--interval <seconds>', 'poll interval in seconds', '5')
    .option('--once', 'fetch a single round then exit', false)
    .action(
      async (cmdOpts: {
        type?: string;
        channel?: string;
        session?: string;
        since?: string;
        interval: string;
        once?: boolean;
      }) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const intervalMs = Math.max(1, Number.parseInt(cmdOpts.interval, 10) || 5) * 1000;
        const emit = (e: EventView) => out(asJson() ? JSON.stringify(e) : formatEventLine(e));
        await eventTail(
          base,
          token,
          {
            type: cmdOpts.type,
            channel: cmdOpts.channel,
            session: cmdOpts.session,
            since: cmdOpts.since,
          },
          emit,
          { fetch: opts.fetch, sleep: opts.sleep, intervalMs, once: cmdOpts.once, stderr: err },
        );
      },
    );
  event
    .command('get')
    .description('Get a single event by id (EventStore.Get)')
    .argument('<id>', 'event id')
    .action(async (id: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const ev = await eventGet(base, token, id, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(ev));
      else out(formatEventLine(ev));
    });
  event
    .command('subs')
    .description('List subscriptions (EventBus.ListSubscriptions)')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const subs = await eventSubs(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(subs));
      else if (!subs.length) out('(no subscriptions)');
      else
        for (const s of subs)
          out(`${s.id ?? '-'}\t${JSON.stringify(s.match)}\t${JSON.stringify(s.sink)}`);
    });

  const channel = program
    .command('channel')
    .description('Manage channel configuration (ChannelRegistry)');
  channel
    .command('list')
    .description('List channels (ChannelRegistry.List)')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const channels = await channelList(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(channels));
      else out(formatChannelListHuman(channels));
    });
  channel
    .command('set')
    .description('Create or update a channel (ChannelRegistry.Write, upsert)')
    .argument('<id>', 'channel id')
    .requiredOption('--adapter <adapter>', 'channel adapter, e.g. webhook')
    .option('--settings <json>', 'settings as a JSON object', '{}')
    .option('--enabled', 'enable the channel', true)
    .option('--no-enabled', 'disable the channel')
    .option('--default-agent <agent>', 'default agent definition name')
    .action(
      async (
        id: string,
        cmdOpts: { adapter: string; settings: string; enabled: boolean; defaultAgent?: string },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        let settings: Record<string, unknown>;
        try {
          const parsed = JSON.parse(cmdOpts.settings);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('not an object');
          }
          settings = parsed as Record<string, unknown>;
        } catch {
          throw new CliError('--settings must be a JSON object', 2);
        }
        const written = await channelSet(
          base,
          token,
          {
            id,
            adapter: cmdOpts.adapter,
            enabled: cmdOpts.enabled,
            settings,
            defaultAgent: cmdOpts.defaultAgent,
          },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(written));
        else out(`Set channel ${written.id}`);
      },
    );
  channel
    .command('connect')
    .description(
      'Host a feishu WS long connection locally, forwarding events to the platform (§2.1 push)',
    )
    .argument(
      '<channelId>',
      'channel id (informational; creds from FEISHU_APP_ID/FEISHU_APP_SECRET env)',
    )
    .action(async (channelId: string) => {
      const base = requireBaseUrl(env());
      const procEnv = opts.env ?? process.env;
      // push 型 adapter 以 plugin 主体 Publish（§2.1/§2.3 豁免面）：优先 WATT_PLUGIN_TOKEN
      // （PluginRegistry.Write 签发的 pluginToken，principal=plugin:channel-feishu——平台据此
      // 保留 source.kind='im' 不规约为 webhook）；缺省回落 user token（kind 会被规约，
      // sourceKind:'im' 订阅不可命中——仅调试用）。
      const pluginToken = procEnv.WATT_PLUGIN_TOKEN?.trim();
      const token = pluginToken || requireToken(env(), credPath, opts.fs);
      const appId = procEnv.FEISHU_APP_ID?.trim();
      const appSecret = procEnv.FEISHU_APP_SECRET?.trim();
      if (!appId || !appSecret) {
        throw new CliError('FEISHU_APP_ID and FEISHU_APP_SECRET must be set to connect', 2);
      }
      err(`watt connect: channel ${channelId} → ${base}`);
      const domain = procEnv.FEISHU_BASE_URL?.trim();
      await runSupervisor({
        connectOnce: () =>
          connectFeishu(
            base,
            token,
            { appId, appSecret, ...(domain ? { domain } : {}) },
            consoleLogger,
          ),
        logger: consoleLogger,
      });
    });

  const context = program
    .command('context')
    .description('Manage context namespaces and entries (ContextProvider / ContextRegistry)');

  /** put/patch 的 content 来源解析：--content > --file > stdin。返回 undefined 表示未提供任何来源。 */
  const resolveContent = async (cmdOpts: {
    content?: string;
    file?: string;
  }): Promise<string | undefined> => {
    if (cmdOpts.content !== undefined) return cmdOpts.content;
    if (cmdOpts.file !== undefined) {
      const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
      try {
        return read(cmdOpts.file);
      } catch (e) {
        throw new CliError(
          `Cannot read --file ${cmdOpts.file}: ${e instanceof Error ? e.message : String(e)}`,
          2,
        );
      }
    }
    const readStdin = opts.readStdin ?? defaultReadStdin;
    return readStdin();
  };

  context
    .command('ls')
    .description('List context entries (ContextProvider.List)')
    .argument('<namespace>', 'context namespace, e.g. feedback/bugs')
    .argument('[path]', 'relative path prefix within the namespace', '')
    .action(async (namespace: string, path: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const items = await contextList(base, token, namespace, path, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(items));
      else out(formatEntryListHuman(items));
    });

  context
    .command('cat')
    .description('Read a single context entry with content (ContextProvider.Get)')
    .argument('<namespace>', 'context namespace')
    .argument('<path>', 'entry path within the namespace')
    .action(async (namespace: string, path: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const entry = await contextGet(base, token, namespace, path, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(entry));
      else out(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content));
    });

  context
    .command('put')
    .description('Create or replace a context entry (ContextProvider.Write, idempotent upsert)')
    .argument('<namespace>', 'context namespace')
    .argument('<path>', 'entry path within the namespace')
    .option('--content <string>', 'entry content inline (else --file, else stdin)')
    .option('--file <path>', 'read content from a file')
    .option('--content-type <type>', 'MIME type, e.g. text/markdown')
    .option('--metadata <key=value>', 'metadata pair (repeatable)', collect, [])
    .option('--if-version <version>', 'optimistic concurrency guard (mismatch → conflict)')
    .action(
      async (
        namespace: string,
        path: string,
        cmdOpts: {
          content?: string;
          file?: string;
          contentType?: string;
          metadata: string[];
          ifVersion?: string;
        },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const content = await resolveContent(cmdOpts);
        if (content === undefined) {
          throw new CliError('No content provided. Use --content, --file, or pipe via stdin.', 2);
        }
        const metadata = parseMetadata(cmdOpts.metadata);
        const written = await contextPut(
          base,
          token,
          namespace,
          path,
          { content, contentType: cmdOpts.contentType, metadata, ifVersion: cmdOpts.ifVersion },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(written));
        else out(`Wrote ${written.uri ?? `context://${namespace}/${path}`}`);
      },
    );

  context
    .command('patch')
    .description('Partially update a context entry (ContextProvider.Update; not_found if absent)')
    .argument('<namespace>', 'context namespace')
    .argument('<path>', 'entry path within the namespace')
    .option('--content <string>', 'replacement content (optional)')
    .option('--file <path>', 'read replacement content from a file')
    .option('--metadata <key=value>', 'metadata pair to shallow-merge (repeatable)', collect, [])
    .option('--if-version <version>', 'optimistic concurrency guard (mismatch → conflict)')
    .action(
      async (
        namespace: string,
        path: string,
        cmdOpts: {
          content?: string;
          file?: string;
          metadata: string[];
          ifVersion?: string;
        },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const metadata = parseMetadata(cmdOpts.metadata);
        // content 仅在显式给出 --content/--file 时读取；patch 允许只改 metadata（不触碰 stdin）。
        let content: string | undefined;
        if (cmdOpts.content !== undefined || cmdOpts.file !== undefined) {
          content = await resolveContent(cmdOpts);
        }
        if (content === undefined && metadata === undefined) {
          throw new CliError('Nothing to patch. Provide --content/--file and/or --metadata.', 2);
        }
        const updated = await contextPatch(
          base,
          token,
          namespace,
          path,
          { content, metadata, ifVersion: cmdOpts.ifVersion },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(updated));
        else out(`Patched ${updated.uri ?? `context://${namespace}/${path}`}`);
      },
    );

  context
    .command('mount')
    .description('Mount a namespace on a provider (ContextRegistry.Write)')
    .argument('<namespace>', 'context namespace to mount')
    .requiredOption('--provider <provider>', 'object | structured | vector | <plugin-id>')
    .option('--ttl <seconds>', 'namespace time-to-live in seconds (whole namespace reclaimed)')
    .option('--read-only', 'reject writes to this namespace', false)
    .option('--provider-config <json>', 'provider-specific config as a JSON object')
    .action(
      async (
        namespace: string,
        cmdOpts: {
          provider: string;
          ttl?: string;
          readOnly: boolean;
          providerConfig?: string;
        },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        let ttl: number | undefined;
        if (cmdOpts.ttl !== undefined) {
          const parsed = Number.parseInt(cmdOpts.ttl, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new CliError('--ttl must be a positive integer (seconds)', 2);
          }
          ttl = parsed;
        }
        let providerConfig: Record<string, unknown> | undefined;
        if (cmdOpts.providerConfig !== undefined) {
          try {
            const p = JSON.parse(cmdOpts.providerConfig);
            if (typeof p !== 'object' || p === null || Array.isArray(p)) {
              throw new Error('not an object');
            }
            providerConfig = p as Record<string, unknown>;
          } catch {
            throw new CliError('--provider-config must be a JSON object', 2);
          }
        }
        const mount = await contextMount(
          base,
          token,
          {
            namespace,
            provider: cmdOpts.provider,
            ttl,
            readOnly: cmdOpts.readOnly ? true : undefined,
            providerConfig,
          },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(mount));
        else out(`Mounted ${mount.namespace ?? namespace} → ${mount.provider ?? cmdOpts.provider}`);
      },
    );

  context
    .command('unmount')
    .description('Unmount a namespace (ContextRegistry.Delete)')
    .argument('<namespace>', 'context namespace to unmount')
    .action(async (namespace: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const result = await contextUnmount(base, token, namespace, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(result));
      else out(`Unmounted ${namespace}`);
    });

  const tool = program
    .command('tool')
    .description('Manage tool source mounts (ToolRegistry; describe/call arrive with the proxy)');
  tool
    .command('ls')
    .description('List tool mounts (ToolRegistry.List, management view)')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const mounts = await toolList(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(mounts));
      else out(formatMountListHuman(mounts));
    });
  tool
    .command('mount')
    .description('Mount a tool source (ToolRegistry.Write, idempotent upsert)')
    .argument('<path>', 'tool tree path, e.g. observability/logs')
    .requiredOption('--provider <provider>', 'mcp | http | builtin | <plugin-id>')
    .option(
      '--config <json>',
      'provider-specific config as a JSON object (endpoint, secretRef, ...)',
    )
    .option('--disabled', 'create the mount in a disabled state', false)
    .action(
      async (path: string, cmdOpts: { provider: string; config?: string; disabled: boolean }) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        let providerConfig: Record<string, unknown> | undefined;
        if (cmdOpts.config !== undefined) {
          try {
            const p = JSON.parse(cmdOpts.config);
            if (typeof p !== 'object' || p === null || Array.isArray(p)) {
              throw new Error('not an object');
            }
            providerConfig = p as Record<string, unknown>;
          } catch {
            throw new CliError('--config must be a JSON object', 2);
          }
        }
        const mount = await toolMount(
          base,
          token,
          {
            path,
            provider: cmdOpts.provider,
            providerConfig,
            enabled: !cmdOpts.disabled,
          },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(mount));
        else out(`Mounted ${mount.path ?? path} → ${mount.provider ?? cmdOpts.provider}`);
      },
    );
  tool
    .command('describe')
    .description('Describe a tool resource (GET /htbp/tools/<path>/~help, HTBP DSL text)')
    .argument('<path>', 'tool tree path, e.g. finance/reports')
    .action(async (path: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const help = await toolDescribe(base, token, path, { fetch: opts.fetch });
      out(help);
    });
  tool
    .command('call')
    .description('Call a tool (POST /htbp/tools/<path>/<tool>, {arguments})')
    .argument('<path>', 'tool tree path, e.g. finance/reports')
    .argument('<tool>', 'tool name exposed by the resource')
    .option('--args <json>', 'call arguments as a JSON object', '{}')
    .action(async (path: string, toolName: string, cmdOpts: { args: string }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      let args: Record<string, unknown>;
      try {
        const p = JSON.parse(cmdOpts.args);
        if (typeof p !== 'object' || p === null || Array.isArray(p)) {
          throw new Error('not an object');
        }
        args = p as Record<string, unknown>;
      } catch {
        throw new CliError('--args must be a JSON object', 2);
      }
      const res = await toolCall(base, token, path, toolName, args, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(res));
      else out(JSON.stringify(res.result, null, 2));
    });

  // ── watt agent（§3.1 AgentRegistry + §3.2 AgentRuntime）─────────────────────
  const agent = program
    .command('agent')
    .description('Manage agent definitions and instances (AgentRegistry / AgentRuntime)');
  agent
    .command('list')
    .description('List agent definitions (AgentRegistry.List)')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const defs = await agentList(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(defs));
      else out(formatDefinitionListHuman(defs));
    });
  agent
    .command('get')
    .description('Get an agent definition by name (AgentRegistry.Get)')
    .argument('<name>', 'agent definition name')
    .action(async (name: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const def = await agentGet(base, token, name, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(def));
      else out(`${def.name}\t${def.runtime}\t${def.description}`);
    });
  agent
    .command('spawn')
    .description('Spawn an agent instance (AgentRuntime.Spawn)')
    .argument('<definition>', 'agent definition name')
    .option('--instance-key <key>', 'idempotency key (same key returns same instance)')
    .option('--input <json>', 'initial input as a JSON value')
    .option('--ttl <seconds>', 'auto-terminate after N seconds')
    .option(
      '--expect-schema <json>',
      'expect a result validated by this JSON Schema (returns correlationId)',
    )
    .option('--correlation-id <id>', 'explicit correlationId for the expected result')
    .option('--timeout-ms <ms>', 'expect timeout in ms')
    .action(
      async (
        definition: string,
        cmdOpts: {
          instanceKey?: string;
          input?: string;
          ttl?: string;
          expectSchema?: string;
          correlationId?: string;
          timeoutMs?: string;
        },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const request: Parameters<typeof agentSpawn>[2] = { definition };
        if (cmdOpts.instanceKey !== undefined) request.instanceKey = cmdOpts.instanceKey;
        if (cmdOpts.input !== undefined) request.input = parseJsonOpt(cmdOpts.input, '--input');
        if (cmdOpts.ttl !== undefined) request.ttl = parsePositiveInt(cmdOpts.ttl, '--ttl');
        const expect = buildExpect(cmdOpts);
        if (expect !== undefined) request.expect = expect;
        const res = await agentSpawn(base, token, request, { fetch: opts.fetch });
        if (asJson()) out(JSON.stringify(res));
        else
          out(
            `Spawned ${res.instance.instanceId}${
              res.correlationId ? ` (correlationId ${res.correlationId})` : ''
            }`,
          );
      },
    );
  agent
    .command('send')
    .description('Send an event to an agent instance (AgentRuntime.Send)')
    .argument('<instanceId>', 'target instance id')
    .option('--type <type>', 'event type', 'agent.message')
    .option('--payload <json>', 'event payload as a JSON value', '{}')
    .option(
      '--expect-schema <json>',
      'expect a result validated by this JSON Schema (returns correlationId)',
    )
    .option('--correlation-id <id>', 'explicit correlationId for the expected result')
    .option('--timeout-ms <ms>', 'expect timeout in ms')
    .action(
      async (
        instanceId: string,
        cmdOpts: {
          type: string;
          payload: string;
          expectSchema?: string;
          correlationId?: string;
          timeoutMs?: string;
        },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const event = {
          source: { kind: 'system' },
          type: cmdOpts.type,
          payload: parseJsonOpt(cmdOpts.payload, '--payload'),
        };
        const expect = buildExpect(cmdOpts);
        const res = await agentSend(base, token, instanceId, event, expect, { fetch: opts.fetch });
        if (asJson()) out(JSON.stringify(res));
        else
          out(
            `Sent (accepted=${res.accepted})${
              res.correlationId ? ` correlationId ${res.correlationId}` : ''
            }`,
          );
      },
    );
  agent
    .command('terminate')
    .description('Terminate an agent instance (AgentRuntime.Terminate)')
    .argument('<instanceId>', 'target instance id')
    .option('--cascade', 'cascade-terminate the derived subtree', false)
    .action(async (instanceId: string, cmdOpts: { cascade: boolean }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      await agentTerminate(base, token, instanceId, cmdOpts.cascade, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify({ terminated: true }));
      else out(`Terminated ${instanceId}${cmdOpts.cascade ? ' (cascade)' : ''}`);
    });
  agent
    .command('tree')
    .description('List agent instances as a derivation tree (AgentRuntime.ListInstances{tree})')
    .argument('[root]', 'root instance id (default: all instances)')
    .action(async (root?: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const items = await agentTree(base, token, root, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(items));
      else out(formatInstanceTreeHuman(items));
    });

  // ── watt task（§8 TaskManager；DoD §7 CLI 五动词 list|get|run|signal|cancel + defs）─────
  const task = program
    .command('task')
    .description('Manage tasks (TaskManager: Workflows-backed long-running tasks)');
  task
    .command('list')
    .description('List tasks (TaskManager.List)')
    .option('--state <state>', 'filter by state (pending|running|waiting_human|...)')
    .option('--definition <name>', 'filter by definition')
    .option('--limit <n>', 'max results')
    .action(async (cmdOpts: { state?: string; definition?: string; limit?: string }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const filter: { state?: string; definition?: string; limit?: number } = {};
      if (cmdOpts.state !== undefined) filter.state = cmdOpts.state;
      if (cmdOpts.definition !== undefined) filter.definition = cmdOpts.definition;
      if (cmdOpts.limit !== undefined) filter.limit = parsePositiveInt(cmdOpts.limit, '--limit');
      const tasks = await taskList(base, token, filter, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(tasks));
      else out(formatTaskListHuman(tasks));
    });
  task
    .command('get')
    .description('Get task detail (TaskManager.Get)')
    .argument('<taskId>', 'task id')
    .action(async (taskId: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const detail = await taskGet(base, token, taskId, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(detail));
      else out(JSON.stringify(detail, null, 2));
    });
  task
    .command('run')
    .description('Start a task (TaskManager.Write; run is the CLI verb per DoD §7)')
    .argument('<definition>', 'deployed template name (see `watt task defs`)')
    .option('--input <json>', 'initial input as a JSON value')
    .option('--task-id <id>', 'explicit task id (idempotent start)')
    .action(async (definition: string, cmdOpts: { input?: string; taskId?: string }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const request: { definition: string; input?: unknown; taskId?: string } = { definition };
      if (cmdOpts.input !== undefined) request.input = parseJsonOpt(cmdOpts.input, '--input');
      if (cmdOpts.taskId !== undefined) request.taskId = cmdOpts.taskId;
      const info = await taskRun(base, token, request, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(info));
      else out(`Started ${info.taskId} (${info.definition}, state=${info.state})`);
    });
  task
    .command('signal')
    .description('Signal a waiting task (TaskManager.Signal; human confirmation)')
    .argument('<taskId>', 'task id')
    .requiredOption('--checkpoint <name>', 'checkpoint name (e.g. confirm-plan)')
    .requiredOption('--decision <decision>', 'approve | reject | custom')
    .option('--payload <json>', 'extra payload as a JSON value')
    .action(
      async (
        taskId: string,
        cmdOpts: { checkpoint: string; decision: string; payload?: string },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const signal: { checkpoint: string; decision: string; payload?: unknown } = {
          checkpoint: cmdOpts.checkpoint,
          decision: cmdOpts.decision,
        };
        if (cmdOpts.payload !== undefined) {
          signal.payload = parseJsonOpt(cmdOpts.payload, '--payload');
        }
        await taskSignal(base, token, taskId, signal, { fetch: opts.fetch });
        if (asJson()) out(JSON.stringify({ signalled: true }));
        else out(`Signalled ${taskId} @${cmdOpts.checkpoint} (${cmdOpts.decision})`);
      },
    );
  task
    .command('cancel')
    .description('Cancel a task (TaskManager.Cancel)')
    .argument('<taskId>', 'task id')
    .option('--reason <reason>', 'cancellation reason')
    .action(async (taskId: string, cmdOpts: { reason?: string }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      await taskCancel(base, token, taskId, cmdOpts.reason, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify({ cancelled: true }));
      else out(`Cancelled ${taskId}`);
    });
  task
    .command('defs')
    .description('List deployed task definitions (TaskManager.ListDefinitions)')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const defs = await taskDefs(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(defs));
      else out(formatTaskDefsHuman(defs));
    });

  // ── watt cron（§7 Scheduler；DoD §7 CLI 四动词 list|create|trigger|rm + get）─────
  const cron = program
    .command('cron')
    .description('Manage scheduled cron jobs (Scheduler: cron/one-shot triggers)');
  cron
    .command('list')
    .description('List cron jobs (Scheduler.List)')
    .option('--limit <n>', 'max results')
    .action(async (cmdOpts: { limit?: string }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const listOpts: { limit?: number } = {};
      if (cmdOpts.limit !== undefined) listOpts.limit = parsePositiveInt(cmdOpts.limit, '--limit');
      const jobs = await cronList(base, token, listOpts, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(jobs));
      else out(formatCronListHuman(jobs));
    });
  cron
    .command('get')
    .description('Get a cron job by id (Scheduler.Get)')
    .argument('<jobId>', 'cron job id')
    .action(async (jobId: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const job = await cronGet(base, token, jobId, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(job));
      else out(JSON.stringify(job, null, 2));
    });
  cron
    .command('create')
    .description(
      'Create or replace a cron job (Scheduler.Write; create is the CLI verb per DoD §7)',
    )
    .argument('<id>', 'cron job id')
    .requiredOption('--schedule <expr>', 'cron expression (minute-level UTC) or ISO one-shot')
    .requiredOption('--action-kind <kind>', 'publish | agent | script')
    .option('--description <text>', 'human description', '')
    .option('--no-enabled', 'create the job disabled')
    // publish action
    .option('--event-type <type>', 'publish: event type')
    .option('--payload <json>', 'publish: event payload as a JSON value')
    .option('--session <session>', 'publish: event session')
    // agent action
    .option('--definition <name>', 'agent: agent definition name')
    .option('--input <json>', 'agent: input as a JSON value')
    .option('--instance-by <mode>', 'agent: singleton | event')
    // script action
    .option('--script-ref <uri>', 'script: context:// URI of the script content')
    .option('--grants <json>', 'script: grants as a JSON array of {resources,actions}')
    .action(
      async (
        id: string,
        cmdOpts: {
          schedule: string;
          actionKind: string;
          description: string;
          enabled: boolean;
          eventType?: string;
          payload?: string;
          session?: string;
          definition?: string;
          input?: string;
          instanceBy?: string;
          scriptRef?: string;
          grants?: string;
        },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const action = buildCronAction(cmdOpts);
        const job: CronJobInput = {
          id,
          description: cmdOpts.description,
          schedule: cmdOpts.schedule,
          enabled: cmdOpts.enabled,
          action,
        };
        const created = await cronCreate(base, token, job, { fetch: opts.fetch });
        if (asJson()) out(JSON.stringify(created));
        else out(`Created cron ${created.id} (${created.schedule}, ${cmdOpts.actionKind})`);
      },
    );
  cron
    .command('trigger')
    .description('Manually trigger a cron job once (Scheduler.Trigger)')
    .argument('<jobId>', 'cron job id')
    .action(async (jobId: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const res = await cronTrigger(base, token, jobId, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(res));
      else out(`Triggered ${jobId} (cron.fired eventId ${res.eventId})`);
    });
  cron
    .command('rm')
    .description('Delete a cron job (Scheduler.Delete)')
    .argument('<jobId>', 'cron job id')
    .action(async (jobId: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      await cronRm(base, token, jobId, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify({ deleted: true }));
      else out(`Removed cron ${jobId}`);
    });

  // ── watt provider（§9 ModelProviderRegistry 最小版）──────────────────────────
  const provider = program
    .command('provider')
    .description('Manage model providers (ModelProviderRegistry)');
  provider
    .command('list')
    .description('List model providers (ModelProviderRegistry.List; secretRef never shown)')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const providers = await providerList(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(providers));
      else out(formatProviderListHuman(providers));
    });
  provider
    .command('add')
    .description('Add or replace a model provider (ModelProviderRegistry.Write, upsert)')
    .argument('<id>', 'provider id, e.g. openrouter-main')
    .requiredOption('--vendor <vendor>', 'e.g. anthropic | workers-ai | openrouter')
    .requiredOption('--models <models>', 'comma-separated model names')
    .requiredOption('--secret-ref <ref>', 'secret reference name (never stored in plaintext)')
    .option('--priority <n>', 'routing priority', '10')
    .option('--default', 'make this the global default provider', false)
    .option('--disabled', 'create the provider disabled', false)
    .action(
      async (
        id: string,
        cmdOpts: {
          vendor: string;
          models: string;
          secretRef: string;
          priority: string;
          default: boolean;
          disabled: boolean;
        },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const models = cmdOpts.models
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean);
        if (!models.length) throw new CliError('--models must list at least one model', 2);
        const created = await providerAdd(
          base,
          token,
          {
            id,
            vendor: cmdOpts.vendor,
            models,
            priority: parsePositiveInt(cmdOpts.priority, '--priority'),
            default: cmdOpts.default,
            secretRef: cmdOpts.secretRef,
            enabled: !cmdOpts.disabled,
          },
          { fetch: opts.fetch },
        );
        if (asJson()) out(JSON.stringify(created));
        else out(`Added provider ${created.id}${created.default ? ' (default)' : ''}`);
      },
    );
  provider
    .command('set-default')
    .description('Set a provider as the single global default (ModelProviderRegistry.SetDefault)')
    .argument('<id>', 'provider id')
    .action(async (id: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const updated = await providerSetDefault(base, token, id, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(updated));
      else out(`Default provider is now ${updated.id}`);
    });

  // ── watt plugin（§11.1 PluginRegistry + §11.2 PluginLifecycle.Health）──────────
  const plugin = program
    .command('plugin')
    .description('Manage plugins (PluginRegistry; register/list/health)');
  plugin
    .command('register')
    .description('Register a plugin (PluginRegistry.Write; returns jwksUrl + pluginToken)')
    .argument('<id>', 'plugin id, e.g. feishu-main')
    .requiredOption(
      '--kind <kind>',
      'context-provider | tool-provider | channel-adapter | agent-harness',
    )
    .requiredOption(
      '--interface-version <ver>',
      'implemented interface version, e.g. tool-provider/v1',
    )
    .requiredOption('--endpoint <url>', 'HTTPS base URL or binding:<name>')
    .option('--health-path <path>', 'health probe path', '/health')
    .option('--secret-ref <ref>', 'bearer auth secret ref (default: platform-token auth)')
    .option('--grants <json>', 'requiredGrants as a JSON array of {resources,actions}', '[]')
    .option('--disabled', 'register the plugin disabled', false)
    .action(
      async (
        id: string,
        cmdOpts: {
          kind: string;
          interfaceVersion: string;
          endpoint: string;
          healthPath: string;
          secretRef?: string;
          grants: string;
          disabled: boolean;
        },
      ) => {
        const base = requireBaseUrl(env());
        const token = requireToken(env(), credPath, opts.fs);
        const grants = parseJsonOpt(cmdOpts.grants, '--grants');
        if (!Array.isArray(grants)) {
          throw new CliError('--grants must be a JSON array', 2);
        }
        const manifest: PluginManifest = {
          id,
          kind: cmdOpts.kind,
          interfaceVersion: cmdOpts.interfaceVersion,
          endpoint: cmdOpts.endpoint,
          auth:
            cmdOpts.secretRef !== undefined
              ? { kind: 'bearer', secretRef: cmdOpts.secretRef }
              : { kind: 'platform-token' },
          requiredGrants: grants as { resources: string[]; actions: string[] }[],
          healthPath: cmdOpts.healthPath,
          enabled: !cmdOpts.disabled,
        };
        const reg = await pluginRegister(base, token, manifest, { fetch: opts.fetch });
        if (asJson()) out(JSON.stringify(reg));
        else
          out(
            `Registered plugin ${reg.id} (${reg.kind}); pluginToken issued, jwksUrl ${reg.jwksUrl}`,
          );
      },
    );
  plugin
    .command('list')
    .description('List plugins (PluginRegistry.List)')
    .option('--kind <kind>', 'filter by plugin kind')
    .action(async (cmdOpts: { kind?: string }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const items = await pluginList(base, token, { kind: cmdOpts.kind }, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(items));
      else out(formatPluginListHuman(items));
    });
  plugin
    .command('health')
    .description('Check a plugin health (PluginLifecycle.Health)')
    .argument('<pluginId>', 'plugin id')
    .action(async (pluginId: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const health = await pluginHealth(base, token, pluginId, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(health));
      else out(formatPluginHealthHuman(pluginId, health));
    });

  // ── watt secret（§6.6 SecretStore：运行时密钥，值绝不走 argv）─────────────────
  const secret = program
    .command('secret')
    .description('Manage runtime secrets (SecretStore; values never shown/logged)');
  secret
    .command('set')
    .description('Set/overwrite a secret (value read from stdin/TTY, never from argv)')
    .argument('<name>', 'secret name matching ^[A-Z][A-Z0-9_]{0,63}$')
    .action(async (name: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      // value 只从 stdin/TTY 读——绝不作 argv（防 shell history 泄漏）。
      const readStdin = opts.readStdin ?? defaultReadStdin;
      if (opts.readStdin === undefined && process.stdin.isTTY) {
        err(`Enter value for secret ${name}, then Ctrl-D:`);
      }
      const raw = await readStdin();
      const value = raw.replace(/\r?\n$/, '');
      if (value.length === 0) {
        throw new CliError('secret value is empty (provide the value via stdin)', 2);
      }
      const result = await secretSet(base, token, name, value, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(result));
      else
        out(
          `Set secret ${result.name} (updatedAt ${result.updatedAt}). KV 传播最长约 1 分钟后生效。`,
        );
    });
  secret
    .command('list')
    .description('List secret names + metadata (values never shown)')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const secrets = await secretList(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(secrets));
      else out(formatSecretListHuman(secrets));
    });
  secret
    .command('rm')
    .description('Remove a secret by name (SecretStore.Delete)')
    .argument('<name>', 'secret name')
    .action(async (name: string) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const result = await secretRm(base, token, name, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(result));
      else out(`Removed secret ${name}`);
    });

  // ── watt setup（部署级引导；P1 飞书 plugin 化）───────────────────────────────
  const setup = program
    .command('setup')
    .description('One-shot deployment-level setup wizards (idempotent)');
  setup
    .command('feishu')
    .description('Register + wire the feishu channel-adapter plugin (idempotent 5 steps)')
    .requiredOption(
      '--endpoint <url>',
      'watt-plugin-feishu worker HTTPS base URL (must be deployed & healthy)',
    )
    .option('--channel <id>', 'channel id to create (default: feishu)', 'feishu')
    .option('--encrypt', 'you plan to use encrypted mode (affects printed guidance only)', false)
    .action(async (cmdOpts: { endpoint: string; channel: string; encrypt: boolean }) => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const result = await setupFeishu(
        base,
        token,
        { endpoint: cmdOpts.endpoint, channelId: cmdOpts.channel, encrypt: cmdOpts.encrypt },
        { fetch: opts.fetch },
      );
      if (asJson()) out(JSON.stringify(result));
      else out(formatSetupGuidance(result));
    });

  let exitCode = 0;
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CliError) {
      err(`watt: ${e.message}`);
      exitCode = e.exitCode;
    } else {
      // commander 的 exitOverride 抛出的 help/version 属正常退出。
      const commanderErr = e as { exitCode?: number; code?: string };
      if (typeof commanderErr.exitCode === 'number') {
        exitCode = commanderErr.exitCode;
      } else {
        err(`watt: ${e instanceof Error ? e.message : String(e)}`);
        exitCode = 1;
      }
    }
  }

  return exitCode;
}
