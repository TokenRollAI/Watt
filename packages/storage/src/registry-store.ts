/**
 * RegistryStore：稳定资源定义的注册表（docs/architecture.md「Registry Store」）。
 * V1 收窄到 M1 实际需要的三类：Agent、AgentVersion、Task。
 * Workspace / Tool / Integration / Workflow 等留待后续里程碑，不预设计。
 *
 * 核心语义：AgentVersion 是不可变纯数据（AgentSpec + 版本号 rev）。
 * - 同 agentVersionId 重复注册且 spec 完全一致：幂等返回已有记录。
 * - 同 agentVersionId 重复注册但 spec 不同：抛 conflict（不可变性被违反）。
 * 这个语义选择（幂等而非硬拒）让重放/重试安全：相同注册命令可安全重发。
 */
import type { AgentSpec } from '@watt/protocol';
import { AgentId, AgentVersionId, TaskId } from '@watt/protocol';

export interface AgentRecord {
  agentId: string;
  /** 显示名，可选 */
  name?: string;
  createdAt: string;
}

/** AgentVersion：不可变。一经写入，(id, spec) 不再变化。 */
export interface AgentVersionRecord {
  agentVersionId: string;
  agentId: string;
  /** 修订号，由 id 语法 agentv_<agent>_<rev> 编码 */
  rev: number;
  spec: AgentSpec;
  createdAt: string;
}

export type TaskStatus = 'open' | 'running' | 'done' | 'cancelled';

export interface TaskRecord {
  taskId: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
}

export interface CreateAgentInput {
  agentId: string;
  name?: string;
}

export interface CreateAgentVersionInput {
  agentVersionId: string;
  agentId: string;
  spec: AgentSpec;
}

export interface CreateTaskInput {
  taskId: string;
  title: string;
}

export interface RegistryStore {
  /** 注册 Agent。重复 agentId 抛 conflict。 */
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
  getAgent(agentId: string): Promise<AgentRecord>;
  listAgents(): Promise<AgentRecord[]>;

  /**
   * 注册 AgentVersion（不可变）。agentVersionId 必须编码 agentId（语法校验）。
   * 同 id 同 spec 幂等返回；同 id 不同 spec 抛 conflict。
   */
  createAgentVersion(input: CreateAgentVersionInput): Promise<AgentVersionRecord>;
  getAgentVersion(agentVersionId: string): Promise<AgentVersionRecord>;
  /** 列出某 Agent 的全部版本，按 rev 升序。 */
  listAgentVersions(agentId: string): Promise<AgentVersionRecord[]>;

  /** 创建 Task。重复 taskId 抛 conflict。 */
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord>;
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<TaskRecord>;
  listTasks(): Promise<TaskRecord[]>;
}

export const assertAgentId = (id: string): string => AgentId.parse(id);
export const assertAgentVersionId = (id: string): string => AgentVersionId.parse(id);
export const assertTaskId = (id: string): string => TaskId.parse(id);
