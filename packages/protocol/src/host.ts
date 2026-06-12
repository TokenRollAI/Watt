/**
 * PlanScript Host API（V1：8 函数）的契约 schema。
 * 见 docs/protocol-v1.md「PlanScript Host API」。
 *
 * 这里定义的是 Host 调用的参数/返回值数据形状（journal 的存储单元、
 * 解释器与 Host 之间的消息），不是解释器内的 JS 接口本身。
 */
import { z } from 'zod';
import { ContextPackage, Lifecycle } from './agent.js';
import { ArtifactId, ResourceRef } from './ids.js';

export const HOST_FUNCTIONS = [
  'run',
  'invoke',
  'spawn',
  'checkpoint',
  'approval',
  'sleep',
  'waitFor',
  'artifact',
] as const;
export const HostFunction = z.enum(HOST_FUNCTIONS);
export type HostFunction = z.infer<typeof HostFunction>;

/** 类型化错误：脚本可 catch 后降级（continue-on-error） */
export const TypedError = z.object({
  code: z.string().min(1),
  message: z.string(),
});
export type TypedError = z.infer<typeof TypedError>;

// ---- 各函数参数 ----

export const RunParams = z.object({
  agent: z.string().min(1),
  ctx: ContextPackage,
});

export const InvokeParams = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});

export const SpawnParams = z.object({
  /** 需要什么能力（自然语言，Factory 的输入） */
  need: z.string().min(1),
  /** 工具授权上限：Factory 产出的 spec 不得超出 */
  maxTools: z.array(z.string()).optional(),
  lifecycle: Lifecycle.default('ephemeral'),
});

export const CheckpointParams = z.object({
  summary: z.string().min(1),
  refs: z.array(ResourceRef).default([]),
});

export const ApprovalParams = z.object({
  prompt: z.string().min(1),
  refs: z.array(ResourceRef).default([]),
});

export const SleepParams = z.object({
  ms: z.number().int().positive(),
});

export const WaitForParams = z.object({
  /** 分层字面键：<integration>/<event>/<correlation> */
  eventKey: z
    .string()
    .regex(/^[a-z0-9_-]+\/[a-z0-9_-]+\/[A-Za-z0-9._:-]+$/, {
      error: 'eventKey must be "<integration>/<event>/<correlation>"',
    }),
  timeoutMs: z.number().int().positive(),
});

export const ArtifactParams = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('write'),
    name: z.string().min(1),
    contentRef: z.string().min(1),
    kind: z.string().min(1),
  }),
  z.object({ op: z.literal('get'), ref: ArtifactId }),
]);

// ---- 各函数返回值 ----

const outcome = <T extends z.ZodRawShape>(shape: T) =>
  z.object({
    status: z.enum(['ok', 'failed']),
    costUsd: z.number().nonnegative(),
    error: TypedError.optional(),
    ...shape,
  });

/** 返回值一律小型结构；大结果落 R2 后以 outputRef 引用 */
export const AgentRunResult = outcome({
  output: z.unknown().optional(),
  outputRef: z.string().optional(),
});
export type AgentRunResult = z.infer<typeof AgentRunResult>;

export const ToolRunResult = outcome({
  output: z.unknown().optional(),
  outputRef: z.string().optional(),
});
export type ToolRunResult = z.infer<typeof ToolRunResult>;

export const SpawnResult = z.object({
  agent: z.string().min(1),
});
export type SpawnResult = z.infer<typeof SpawnResult>;

export const CheckpointResult = z.object({ ref: ResourceRef });
export type CheckpointResult = z.infer<typeof CheckpointResult>;

export const ApprovalResult = z.object({
  approved: z.boolean(),
  note: z.string().optional(),
});
export type ApprovalResult = z.infer<typeof ApprovalResult>;

export const SleepResult = z.object({});

export const WaitResult = z.object({
  status: z.enum(['received', 'timeout']),
  payload: z.unknown().optional(),
});
export type WaitResult = z.infer<typeof WaitResult>;

export const ArtifactResult = z.object({
  ref: ArtifactId,
  name: z.string(),
  kind: z.string(),
  url: z.url().optional(),
});
export type ArtifactResult = z.infer<typeof ArtifactResult>;

// ---- Journal ----

const entry = <F extends HostFunction, P extends z.ZodType, R extends z.ZodType>(
  fn: F,
  params: P,
  result: R,
) =>
  z.object({
    /** Host 调用按发起顺序分配的确定性序号，journal 以此为键 */
    seq: z.number().int().nonnegative(),
    fn: z.literal(fn),
    params,
    /** pending 调用尚无 result */
    result: result.optional(),
  });

/** journal 单条记录：重放时按 seq 返回缓存 result，快进执行流 */
export const JournalEntry = z.discriminatedUnion('fn', [
  entry('run', RunParams, AgentRunResult),
  entry('invoke', InvokeParams, ToolRunResult),
  entry('spawn', SpawnParams, SpawnResult),
  entry('checkpoint', CheckpointParams, CheckpointResult),
  entry('approval', ApprovalParams, ApprovalResult),
  entry('sleep', SleepParams, SleepResult),
  entry('waitFor', WaitForParams, WaitResult),
  entry('artifact', ArtifactParams, ArtifactResult),
]);
export type JournalEntry = z.infer<typeof JournalEntry>;

/** 预算超限：不可被脚本捕获，直接终止 Run */
export const BUDGET_EXCEEDED = 'BudgetExceeded' as const;
