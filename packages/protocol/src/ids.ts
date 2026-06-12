/**
 * ID 语法：前缀编码资源所有权，是结构性强制不变量的第一道防线。
 * 见 docs/protocol-v1.md「ID 语法」。
 *
 * 设计要点：
 * - `sess` 语法中没有 run 成分，`run` 语法中没有 session 成分。
 * - `arun` / `trun` 的 seq 由 PlanScript Host 按发起顺序确定性分配。
 */
import { ulid } from 'ulid';
import { z } from 'zod';

const ULID_RE = '[0-9A-HJKMNP-TV-Z]{26}';

/** 各资源 ID 的正则。run 系 ID 编码父资源，校验即验所有权链。 */
export const ID_PATTERNS = {
  workspace: new RegExp(`^ws_${ULID_RE}$`),
  task: new RegExp(`^task_${ULID_RE}$`),
  run: new RegExp(`^run_${ULID_RE}_${ULID_RE}$`),
  agentRun: new RegExp(`^arun_${ULID_RE}_${ULID_RE}_\\d+$`),
  toolRun: new RegExp(`^trun_${ULID_RE}_${ULID_RE}_\\d+$`),
  agent: new RegExp(`^agent_${ULID_RE}$`),
  agentVersion: new RegExp(`^agentv_${ULID_RE}_\\d+$`),
  session: new RegExp(`^sess_${ULID_RE}_${ULID_RE}$`),
  planVersion: new RegExp(`^plan_${ULID_RE}_${ULID_RE}_\\d+$`),
  checkpoint: new RegExp(`^ckpt_${ULID_RE}$`),
  artifact: new RegExp(`^art_${ULID_RE}$`),
  memory: new RegExp(`^mem_${ULID_RE}$`),
} as const;

export type IdKind = keyof typeof ID_PATTERNS;

const idSchema = (kind: IdKind) =>
  z.string().regex(ID_PATTERNS[kind], { error: `invalid ${kind} id` });

export const WorkspaceId = idSchema('workspace');
export const TaskId = idSchema('task');
export const RunId = idSchema('run');
export const AgentRunId = idSchema('agentRun');
export const ToolRunId = idSchema('toolRun');
export const AgentId = idSchema('agent');
export const AgentVersionId = idSchema('agentVersion');
export const SessionId = idSchema('session');
export const PlanVersionId = idSchema('planVersion');
export const CheckpointId = idSchema('checkpoint');
export const ArtifactId = idSchema('artifact');
export const MemoryId = idSchema('memory');

/** ContextRef / Host artifact 等处接受的"带前缀引用"：受认资源 ID。 */
export const ResourceRef = z.union([
  CheckpointId,
  ArtifactId,
  MemoryId,
  RunId,
  AgentRunId,
  SessionId,
]);

const tail = (id: string) => id.slice(id.indexOf('_') + 1);

export const newWorkspaceId = () => `ws_${ulid()}`;
export const newTaskId = () => `task_${ulid()}`;
export const newRunId = (taskId: string) => `run_${tail(TaskId.parse(taskId))}_${ulid()}`;
export const newAgentRunId = (runId: string, seq: number) =>
  `arun_${tail(RunId.parse(runId))}_${seq}`;
export const newToolRunId = (runId: string, seq: number) =>
  `trun_${tail(RunId.parse(runId))}_${seq}`;
export const newAgentId = () => `agent_${ulid()}`;
export const newAgentVersionId = (agentId: string, rev: number) =>
  `agentv_${tail(AgentId.parse(agentId))}_${rev}`;
export const newSessionId = (agentId: string) => `sess_${tail(AgentId.parse(agentId))}_${ulid()}`;
export const newPlanVersionId = (runId: string, rev: number) =>
  `plan_${tail(RunId.parse(runId))}_${rev}`;
export const newCheckpointId = () => `ckpt_${ulid()}`;
export const newArtifactId = () => `art_${ulid()}`;
export const newMemoryId = () => `mem_${ulid()}`;

/**
 * invoke 幂等 key：Host 以 run_id + seq 自动派生，脚本无感知；
 * 直连会话以 session_id + 消息序号派生。
 */
export const idempotencyKeyForHostCall = (runId: string, seq: number) =>
  `${RunId.parse(runId)}:${seq}`;
export const idempotencyKeyForSessionMessage = (sessionId: string, messageSeq: number) =>
  `${SessionId.parse(sessionId)}:${messageSeq}`;
