/**
 * RegistryStore 的内存实现。
 *
 * AgentVersion 不可变：同 id 重复注册按 spec 深比较裁决——一致幂等返回，
 * 不一致抛 conflict。spec 用 AgentSpec.parse 规范化（剥离未知字段）后再比较与存储，
 * 保证比较基于协议定义的纯数据。
 */
import { AgentSpec as AgentSpecSchema } from '@watt/protocol';
import { conflict, notFound, validation } from '../errors.js';
import type {
  AgentRecord,
  AgentVersionRecord,
  CreateAgentInput,
  CreateAgentVersionInput,
  CreateTaskInput,
  RegistryStore,
  TaskRecord,
  TaskStatus,
} from '../registry-store.js';
import {
  assertAgentId,
  assertAgentVersionId,
  assertTaskId,
} from '../registry-store.js';

/** 顺序无关的 JSON 深比较（spec 是纯数据）。 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length) return false;
    return ak.every((k, i) => k === bk[i] && jsonEqual(ao[k], bo[k]));
  }
  return false;
}

/** 从 agentv_<agent_ulid>_<rev> 解析出 agent id 与 rev。 */
function parseAgentVersionId(id: string): { agentId: string; rev: number } {
  // 形如 agentv_<26ulid>_<rev>
  const body = id.slice('agentv_'.length);
  const lastUnderscore = body.lastIndexOf('_');
  const agentUlid = body.slice(0, lastUnderscore);
  const rev = Number(body.slice(lastUnderscore + 1));
  return { agentId: `agent_${agentUlid}`, rev };
}

export class InMemoryRegistryStore implements RegistryStore {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly versions = new Map<string, AgentVersionRecord>();
  private readonly tasks = new Map<string, TaskRecord>();

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const agentId = assertAgentId(input.agentId);
    if (this.agents.has(agentId)) throw conflict(`agent already exists: ${agentId}`);
    const record: AgentRecord = {
      agentId,
      createdAt: new Date().toISOString(),
      ...(input.name ? { name: input.name } : {}),
    };
    this.agents.set(agentId, record);
    return { ...record };
  }

  async getAgent(agentId: string): Promise<AgentRecord> {
    const record = this.agents.get(assertAgentId(agentId));
    if (!record) throw notFound(`agent not found: ${agentId}`);
    return { ...record };
  }

  async listAgents(): Promise<AgentRecord[]> {
    return [...this.agents.values()].map((r) => ({ ...r }));
  }

  async createAgentVersion(input: CreateAgentVersionInput): Promise<AgentVersionRecord> {
    const agentVersionId = assertAgentVersionId(input.agentVersionId);
    const agentId = assertAgentId(input.agentId);
    const { agentId: encodedAgentId, rev } = parseAgentVersionId(agentVersionId);
    if (encodedAgentId !== agentId) {
      throw validation(
        `agentVersionId ${agentVersionId} does not encode agentId ${agentId}`,
      );
    }
    // 规范化为纯数据后比较与存储。
    const spec = AgentSpecSchema.parse(input.spec);
    const existing = this.versions.get(agentVersionId);
    if (existing) {
      // 不可变：spec 一致幂等返回，不一致冲突。
      if (jsonEqual(existing.spec, spec)) return { ...existing, spec: structuredClone(spec) };
      throw conflict(`agentVersion ${agentVersionId} already exists with different spec`);
    }
    const record: AgentVersionRecord = {
      agentVersionId,
      agentId,
      rev,
      spec,
      createdAt: new Date().toISOString(),
    };
    this.versions.set(agentVersionId, record);
    return { ...record, spec: structuredClone(spec) };
  }

  async getAgentVersion(agentVersionId: string): Promise<AgentVersionRecord> {
    const record = this.versions.get(assertAgentVersionId(agentVersionId));
    if (!record) throw notFound(`agentVersion not found: ${agentVersionId}`);
    return { ...record, spec: structuredClone(record.spec) };
  }

  async listAgentVersions(agentId: string): Promise<AgentVersionRecord[]> {
    const id = assertAgentId(agentId);
    return [...this.versions.values()]
      .filter((v) => v.agentId === id)
      .sort((a, b) => a.rev - b.rev)
      .map((v) => ({ ...v, spec: structuredClone(v.spec) }));
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const taskId = assertTaskId(input.taskId);
    if (this.tasks.has(taskId)) throw conflict(`task already exists: ${taskId}`);
    const record: TaskRecord = {
      taskId,
      title: input.title,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, record);
    return { ...record };
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    const record = this.tasks.get(assertTaskId(taskId));
    if (!record) throw notFound(`task not found: ${taskId}`);
    return { ...record };
  }

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<TaskRecord> {
    const record = this.tasks.get(assertTaskId(taskId));
    if (!record) throw notFound(`task not found: ${taskId}`);
    const updated: TaskRecord = { ...record, status };
    this.tasks.set(record.taskId, updated);
    return { ...updated };
  }

  async listTasks(): Promise<TaskRecord[]> {
    return [...this.tasks.values()].map((r) => ({ ...r }));
  }
}
