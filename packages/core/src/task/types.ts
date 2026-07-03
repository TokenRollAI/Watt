import { z } from 'zod';
import { cronActionSchema, principalRefSchema, timestampSchema, uriSchema } from '../types.ts';

/**
 * Task + Scheduler 类型层（Proto §8 TaskManager / §7 Scheduler）——纯 zod，无 Cloudflare 绑定。
 *
 * 复用 ../types.ts 的既有 schema：
 *   - cronActionSchema（§7 三 action：publish|agent|script）已在 authz 判定面定义完整，此处直接复用；
 *   - principalRefSchema / timestampSchema / uriSchema（§0.1/§0.2/§0.3）。
 * ../types.ts 的 cronJobSchema 是 authz 判定用的最小面（id/enabled/action）；本文件的
 * cronJobSchema 是 §7 规范全字段面（id/description/schedule/enabled/action/createdBy），
 * 用于 Scheduler 接口的 Write/Get 请求校验——二者用途不同，故此处独立声明全字段面。
 */

// ─── Task 7 态状态机（§8 TaskInfo.state L809-810）───────────────────────────
export const taskStateSchema = z.enum([
  'pending',
  'running',
  'waiting_human',
  'waiting_event',
  'done',
  'failed',
  'cancelled',
]);
export type TaskState = z.infer<typeof taskStateSchema>;

// ─── TaskInfo（§8 L806-815）────────────────────────────────────────────────
// definition 是不透明引用（当前解析为已部署模板名，§8 L797）；currentStep? 引擎驱动。
// note? 非 Proto TaskInfo 字段，但 Update 补 note 后需在 Info 承载——设为可选，与 Update 语义对齐。
export const taskInfoSchema = z.object({
  taskId: z.string(),
  definition: z.string(),
  state: taskStateSchema,
  currentStep: z.string().optional(),
  createdBy: principalRefSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  note: z.string().optional(),
});
export type TaskInfo = z.infer<typeof taskInfoSchema>;

// ─── TaskDetail（§8 L817-825）──────────────────────────────────────────────
// steps[]：每步 name/state（开放字符串，引擎自定）+ startedAt?/output?。
// pendingCheckpoint?：waiting_human 时存在（checkpoint/prompt/requestedAt）。
// artifacts：产物 context:// 引用（URI[]）。
export const taskStepSchema = z.object({
  name: z.string(),
  state: z.string(),
  startedAt: timestampSchema.optional(),
  output: z.unknown().optional(),
});
export type TaskStep = z.infer<typeof taskStepSchema>;

export const pendingCheckpointSchema = z.object({
  checkpoint: z.string(),
  prompt: z.string(),
  requestedAt: timestampSchema,
});
export type PendingCheckpoint = z.infer<typeof pendingCheckpointSchema>;

export const taskDetailSchema = taskInfoSchema.extend({
  steps: z.array(taskStepSchema),
  pendingCheckpoint: pendingCheckpointSchema.optional(),
  artifacts: z.array(uriSchema),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

// ─── Signal 请求（§8 Signal L802-803）──────────────────────────────────────
// decision 三态；payload? 附带载荷（custom 决策的补充数据）。
export const signalDecisionSchema = z.enum(['approve', 'reject', 'custom']);
export type SignalDecision = z.infer<typeof signalDecisionSchema>;

export const signalRequestSchema = z.object({
  checkpoint: z.string(),
  decision: signalDecisionSchema,
  payload: z.unknown().optional(),
});
export type SignalRequest = z.infer<typeof signalRequestSchema>;

// ─── TaskManager.Write 请求（§8 L799）──────────────────────────────────────
// definition 不透明引用；input? 启动入参；taskId? 幂等指定（缺省平台生成）。
export const taskWriteRequestSchema = z.object({
  definition: z.string(),
  input: z.unknown().optional(),
  taskId: z.string().optional(),
});
export type TaskWriteRequest = z.infer<typeof taskWriteRequestSchema>;

// ─── CronJob 全字段面（§7 L752-772）─────────────────────────────────────────
// action 复用 ../types.ts 的 cronActionSchema（publish|agent|script 三 discriminated union）。
// schedule：cron 表达式（分钟级 UTC）或 ISO 时刻（一次性）——形状由 cron.ts 的 parseCronSchedule 判定，
//   此处 schema 只校验非空字符串（语义合法性属运行时解析面）。
// createdBy：审计 principal（§7 L771 PrincipalRef）。
export const cronJobSchema = z.object({
  id: z.string(),
  description: z.string(),
  schedule: z.string(),
  enabled: z.boolean(),
  action: cronActionSchema,
  createdBy: principalRefSchema,
});
export type CronJob = z.infer<typeof cronJobSchema>;
