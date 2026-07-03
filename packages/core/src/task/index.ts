// Task + Scheduler 纯逻辑（Proto §7 Scheduler / §8 TaskManager / §1.1 checkpoint / §3.4 事件名）
// ——无 Cloudflare 绑定。gateway 后续从此桶 import（consumer type guard 下沉、Signal 判定、
// 事件名净化、cron 解析）。

export {
  type Decision as CheckpointDecision,
  type ImActionSignal,
  parseImActionSignal,
  parseTaskCheckpoint,
  type TaskCheckpointPayload,
} from './checkpoint.ts';
export {
  nextFireTime,
  type ParsedCron,
  type ParsedOnce,
  type ParsedSchedule,
  parseCronSchedule,
} from './cron.ts';
export {
  agentResultEventName,
  assertEventName,
  sanitizeEventName,
  taskSignalEventName,
} from './event-names.ts';
export { applySignalTransition, checkSignalable } from './signal.ts';
export {
  type CronJob as SchedulerCronJob,
  cronJobSchema as schedulerCronJobSchema,
  type PendingCheckpoint,
  pendingCheckpointSchema,
  type SignalDecision,
  type SignalRequest,
  signalDecisionSchema,
  signalRequestSchema,
  type TaskDetail,
  type TaskInfo,
  type TaskState,
  type TaskStep,
  type TaskWriteRequest,
  taskDetailSchema,
  taskInfoSchema,
  taskStateSchema,
  taskStepSchema,
  taskWriteRequestSchema,
} from './types.ts';
