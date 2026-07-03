import { Command } from 'commander';
import { auditList, formatAuditListHuman } from './audit.ts';
import { channelList, channelSet, formatChannelListHuman } from './channel.ts';
import { credentialsPath, type FsDeps, requireBaseUrl, requireToken } from './client.ts';
import { CliError, readEnv } from './env.ts';
import { type EventView, eventGet, eventSubs, eventTail, formatEventLine } from './event.ts';
import { approveDevice, type DeviceAuthorizeResponse, login } from './login.ts';
import { formatPolicyListHuman, policyAdd, policyList, policyRm } from './policy.ts';
import { fetchStatus, formatStatusHuman } from './status.ts';
import { formatWhoamiHuman, whoami } from './whoami.ts';

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
    .description('GET <WATT_BASE_URL>/healthz and print a health summary')
    .action(async () => {
      const result = await fetchStatus(env(), { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(result.raw));
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

  const audit = program.command('audit').description('Inspect the audit log');
  audit
    .command('list')
    .description('List audit records (platform://audit read; Phase 1: interface only)')
    .action(async () => {
      const base = requireBaseUrl(env());
      const token = requireToken(env(), credPath, opts.fs);
      const result = await auditList(base, token, { fetch: opts.fetch });
      if (asJson()) out(JSON.stringify(result));
      else out(formatAuditListHuman(result));
    });

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
