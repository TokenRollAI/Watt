import { describe, expect, it } from 'vitest';
import {
  newAgentId,
  newAgentVersionId,
  newTaskId,
  type AgentSpec,
} from '@watt/protocol';
import { InMemoryRegistryStore } from '../src/index.js';

const baseSpec = (): AgentSpec => ({
  instructions: 'do research',
  outputSchema: { type: 'object' },
  tools: [{ tool: 'search' }],
  model: { id: 'deepseek/deepseek-chat' },
  runtime: 'worker',
  lifecycle: 'ephemeral',
});

describe('RegistryStore Agent', () => {
  it('创建 / 取 / 列表；重复 conflict', async () => {
    const store = new InMemoryRegistryStore();
    const agentId = newAgentId();
    await store.createAgent({ agentId, name: 'Researcher' });
    const got = await store.getAgent(agentId);
    expect(got.name).toBe('Researcher');
    expect(await store.listAgents()).toHaveLength(1);
    await expect(store.createAgent({ agentId })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('坏 agentId 抛错', async () => {
    const store = new InMemoryRegistryStore();
    await expect(store.createAgent({ agentId: 'bad' })).rejects.toThrow();
  });
});

describe('RegistryStore AgentVersion 不可变性', () => {
  it('同 id 同 spec 幂等返回', async () => {
    const store = new InMemoryRegistryStore();
    const agentId = newAgentId();
    const versionId = newAgentVersionId(agentId, 1);
    const a = await store.createAgentVersion({ agentVersionId: versionId, agentId, spec: baseSpec() });
    const b = await store.createAgentVersion({ agentVersionId: versionId, agentId, spec: baseSpec() });
    expect(b.agentVersionId).toBe(a.agentVersionId);
    expect(b.rev).toBe(1);
    expect(b.spec).toEqual(a.spec);
  });

  it('同 id 不同 spec 抛 conflict（不可变性）', async () => {
    const store = new InMemoryRegistryStore();
    const agentId = newAgentId();
    const versionId = newAgentVersionId(agentId, 1);
    await store.createAgentVersion({ agentVersionId: versionId, agentId, spec: baseSpec() });
    const changed = { ...baseSpec(), instructions: 'changed' };
    await expect(
      store.createAgentVersion({ agentVersionId: versionId, agentId, spec: changed }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('spec 的未知字段被剥离后再比较（纯数据语义）', async () => {
    const store = new InMemoryRegistryStore();
    const agentId = newAgentId();
    const versionId = newAgentVersionId(agentId, 1);
    await store.createAgentVersion({ agentVersionId: versionId, agentId, spec: baseSpec() });
    // 带未知字段，剥离后与已有一致 => 幂等，不冲突。
    const withJunk = { ...baseSpec(), junk: 'ignored' } as unknown as AgentSpec;
    const again = await store.createAgentVersion({
      agentVersionId: versionId,
      agentId,
      spec: withJunk,
    });
    expect('junk' in again.spec).toBe(false);
  });

  it('agentVersionId 必须编码其 agentId', async () => {
    const store = new InMemoryRegistryStore();
    const agentId = newAgentId();
    const otherAgentId = newAgentId();
    const versionId = newAgentVersionId(otherAgentId, 1); // 编码了别的 agent
    await expect(
      store.createAgentVersion({ agentVersionId: versionId, agentId, spec: baseSpec() }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('listAgentVersions 按 rev 升序，仅返回该 agent 的版本', async () => {
    const store = new InMemoryRegistryStore();
    const agentId = newAgentId();
    const otherAgentId = newAgentId();
    await store.createAgentVersion({
      agentVersionId: newAgentVersionId(agentId, 2),
      agentId,
      spec: baseSpec(),
    });
    await store.createAgentVersion({
      agentVersionId: newAgentVersionId(agentId, 1),
      agentId,
      spec: baseSpec(),
    });
    await store.createAgentVersion({
      agentVersionId: newAgentVersionId(otherAgentId, 1),
      agentId: otherAgentId,
      spec: baseSpec(),
    });
    const versions = await store.listAgentVersions(agentId);
    expect(versions.map((v) => v.rev)).toEqual([1, 2]);
  });

  it('坏 spec（缺字段）抛错', async () => {
    const store = new InMemoryRegistryStore();
    const agentId = newAgentId();
    const versionId = newAgentVersionId(agentId, 1);
    await expect(
      store.createAgentVersion({
        agentVersionId: versionId,
        agentId,
        spec: { instructions: 'x' } as unknown as AgentSpec,
      }),
    ).rejects.toThrow();
  });
});

describe('RegistryStore Task', () => {
  it('创建 / 取 / 状态推进 / 列表', async () => {
    const store = new InMemoryRegistryStore();
    const taskId = newTaskId();
    await store.createTask({ taskId, title: 'ship M1' });
    expect((await store.getTask(taskId)).status).toBe('open');
    const running = await store.updateTaskStatus(taskId, 'running');
    expect(running.status).toBe('running');
    expect(await store.listTasks()).toHaveLength(1);
    await expect(store.createTask({ taskId, title: 'dup' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
