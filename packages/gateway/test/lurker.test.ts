/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { Event } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent/agent-registry.ts';
import { AgentRuntime, defaultRuntimeDeps } from '../src/agent/agent-runtime.ts';
import type { ModelCallRequest } from '../src/agent/harness/types.ts';
import {
  LURKER_SCRIBE_DEF,
  runLurkerHarness,
  SCRATCH_TTL_SEC,
  scratchNamespace,
} from '../src/agent/lurker.ts';
import { StructuredContextProvider } from '../src/context/providers/structured.ts';
import type { Bindings } from '../src/env.ts';
import { EventStore } from '../src/event/event-store.ts';

/**
 * 潜伏群聊 agent（Case 3 / E2E-3，R31 B5）集成测试——真实 workerd（DO + D1）。
 * 覆盖：静默消息 → scratch namespace 记录且零出站；@watt 提及 → 出站回答（含上下文条数）；
 * session 粘性（同 session 恒同实例键）；scratch mount 带 TTL。
 */

const SESSION = 'feishu:chat:oc_lurk_1';

function imMessage(id: string, text: string): Event {
  return {
    id,
    source: { kind: 'im', channel: 'feishu-main' },
    type: 'im.message',
    session: SESSION,
    channelUser: { channel: 'feishu', userId: 'ou_x' },
    payload: { text },
    occurredAt: '2026-07-04T00:00:00.000Z',
    traceId: `tr-${id}`,
  };
}

async function clearDb() {
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
  await env.DB_CONTEXT.prepare('DELETE FROM entries').run();
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await new AgentRegistry(env.DB_PROVIDERS).write(LURKER_SCRIBE_DEF);
  // R32 出站 Check：lurker 回答需 allow 策略（subject=agent 定义级）+ def grants（已在 DEF 声明）。
  const { PolicyStore } = await import('../src/authz/policy-store.ts');
  await new PolicyStore(env.DB_POLICIES).write({
    id: 'test-lurker-outbound',
    subject: 'agent:lurker/scribe',
    resource: 'event://*',
    actions: ['write'],
    effect: 'allow',
  });
}

beforeEach(clearDb);

/** spawn（session 粘性键）+ send 一条 im.message 给 lurker 实例。 */
async function deliver(event: Event): Promise<string> {
  const runtime = new AgentRuntime(defaultRuntimeDeps(env));
  const key = `agent:lurker/scribe#session:${SESSION}`;
  const spawn = await runtime.spawn({
    definition: 'lurker/scribe',
    instanceKey: key,
    input: {},
  });
  if ('code' in spawn) throw new Error(spawn.message);
  const sent = await runtime.send(key, event);
  if ('code' in sent) throw new Error(sent.message);
  return key;
}

describe('lurker/scribe (Case 3 / E2E-3)', () => {
  it('silent message → recorded into TTL scratch namespace, zero outbound', async () => {
    await deliver(imMessage('m1', '今天的部署排期定了吗'));
    // scratch 条目存在。
    const ns = scratchNamespace(SESSION);
    const provider = new StructuredContextProvider(env.DB_CONTEXT, ns);
    const entry = await provider.get('m1');
    expect('code' in entry).toBe(false);
    if (!('code' in entry)) {
      expect(JSON.parse(String(entry.content))).toMatchObject({ text: '今天的部署排期定了吗' });
    }
    // 零出站（判据①）。
    const store = new EventStore(env.DB_EVENTS);
    const out = await store.list({ filter: { type: 'outbound.message' } });
    if ('code' in out) throw new Error(out.message);
    expect(out.items).toHaveLength(0);
    // scratch mount 带 TTL（判据② TTL 生效面：到期回收由 ContextRegistry 既有 TTL 测试覆盖）。
    const registry = env.CONTEXT_REGISTRY.get(env.CONTEXT_REGISTRY.idFromName('registry'));
    // DO RPC 联合类型 narrow-to-never（pitfalls §31）——经 unknown 投影后断言。
    const mount = (await registry.get(ns)) as unknown as { code?: string; ttl?: number };
    expect(mount.code).toBeUndefined();
    expect(mount.ttl).toBe(SCRATCH_TTL_SEC);
  });

  it('5 silent messages then @watt question → answer cites the context count (判据②③)', async () => {
    for (let i = 0; i < 5; i++) {
      await deliver(imMessage(`s${i}`, `群消息 ${i}`));
    }
    const ns = scratchNamespace(SESSION);
    const provider = new StructuredContextProvider(env.DB_CONTEXT, ns);
    const page = await provider.list('');
    if ('code' in page) throw new Error(page.message);
    expect(page.items.length).toBeGreaterThanOrEqual(5); // 判据②：≥5 条目

    await deliver(imMessage('q1', '@watt 刚才大家聊了什么？'));
    const store = new EventStore(env.DB_EVENTS);
    const out = await store.list({ filter: { type: 'outbound.message' } });
    if ('code' in out) throw new Error(out.message);
    expect(out.items).toHaveLength(1); // 只有 @ 才出站（判据①③）
    const text = String(
      (out.items[0]?.payload as { content?: { text?: string } }).content?.text ?? '',
    );
    expect(text).toContain('5 条上下文');
    expect(text).toContain('刚才大家聊了什么');
    // target = session 末段（渠道内会话 id）。
    expect((out.items[0]?.payload as { target?: string }).target).toBe('oc_lurk_1');
  });

  it('outbound Check denies the answer when no allow policy exists (R32 出站鉴权)', async () => {
    // 删掉 allow 策略——@watt 回答应 failed(rejected) 且零出站（deny 留审计）。
    await env.DB_POLICIES.prepare('DELETE FROM policies').run();
    await deliver(imMessage('d1', '@watt 在吗'));
    const store = new EventStore(env.DB_EVENTS);
    const out = await store.list({ filter: { type: 'outbound.message' } });
    if ('code' in out) throw new Error(out.message);
    expect(out.items).toHaveLength(0);
    // deny 审计留痕。
    const audit = await env.DB_AUDIT.prepare(
      "SELECT decision FROM audit_records WHERE resource LIKE 'event://%' ORDER BY at DESC LIMIT 1",
    ).first<{ decision: string }>();
    expect(audit?.decision).toBe('deny');
  });

  it('session stickiness: declarative subscription resolves the same instance key (判据④)', async () => {
    // 声明式订阅已随 def Write 建立（agent-registry 联动）——同 session 的 resolveInstanceKey 恒同键。
    const { resolveInstanceKey } = await import('@watt/core');
    const sink = {
      kind: 'agent' as const,
      definition: 'lurker/scribe',
      instanceBy: 'session' as const,
    };
    const k1 = resolveInstanceKey(sink, imMessage('a', 'x'));
    const k2 = resolveInstanceKey(sink, imMessage('b', 'y'));
    if ('error' in k1 || 'error' in k2) throw new Error('key resolution failed');
    expect(k1.key).toBe(k2.key);
    expect(k1.key).toBe(`agent:lurker/scribe#session:${SESSION}`);
  });

  // ── R33：@回答接真实模型（llm 注入面）——前缀恒定 + 正文 LLM/模板兜底 + @消息记 scratch ──

  it('llm injected → answer = 「N 条上下文」前缀 + 模型文本; @消息记入 scratch; 上下文进 system', async () => {
    await deliver(imMessage('c1', '早上好'));
    let seen: ModelCallRequest | undefined;
    const outcome = await runLurkerHarness(
      env as unknown as Bindings,
      imMessage('q9', '@watt 群里聊了啥'),
      {
        caller: {
          async call(req) {
            seen = req;
            return { text: '大家在聊部署排期。' };
          },
        },
        model: 'test-model',
      },
    );
    expect(outcome).toMatchObject({ kind: 'result', output: { answered: true, llm: true } });
    const store = new EventStore(env.DB_EVENTS);
    const out = await store.list({ filter: { type: 'outbound.message' } });
    if ('code' in out) throw new Error(out.message);
    const text = String(
      (out.items[0]?.payload as { content?: { text?: string } }).content?.text ?? '',
    );
    expect(text).toBe('（基于本群 1 条上下文）大家在聊部署排期。');
    // 上下文行进了 system（不构成指令的引用块）；模型收到问句与模型名。
    expect(seen?.system).toContain('早上好');
    expect(seen?.prompt).toBe('群里聊了啥');
    expect(seen?.model).toBe('test-model');
    // @消息本身也记入 scratch（后续提问可引用）。
    const provider = new StructuredContextProvider(env.DB_CONTEXT, scratchNamespace(SESSION));
    const entry = await provider.get('q9');
    expect('code' in entry).toBe(false);
  });

  it('llm caller throws → 回退模板文案（前缀保持）', async () => {
    const outcome = await runLurkerHarness(
      env as unknown as Bindings,
      imMessage('q10', '@watt 在吗'),
      {
        caller: {
          async call() {
            throw new Error('model down');
          },
        },
        model: 'test-model',
      },
    );
    expect(outcome).toMatchObject({ kind: 'result', output: { answered: true, llm: false } });
    const store = new EventStore(env.DB_EVENTS);
    const out = await store.list({ filter: { type: 'outbound.message' } });
    if ('code' in out) throw new Error(out.message);
    const text = String(
      (out.items[0]?.payload as { content?: { text?: string } }).content?.text ?? '',
    );
    expect(text).toContain('条上下文）你问：「在吗」');
  });

  it('toolScopes 纯路径条目 → 模型收到 htbp 三工具 + system 带使用说明', async () => {
    let seen: ModelCallRequest | undefined;
    await runLurkerHarness(env as unknown as Bindings, imMessage('q11', '@watt 有什么工具'), {
      caller: {
        async call(req) {
          seen = req;
          return { text: 'ok' };
        },
      },
      model: 'test-model',
      toolScopes: ['test', 'platform://scheduler'],
    });
    const names = (seen?.tools ?? []).map((t) => t.name);
    expect(names).toContain('htbp_call');
    expect(names).toContain('htbp_help');
    expect(seen?.system).toContain('test');
  });
});
