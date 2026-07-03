/**
 * task.checkpoint / im.action 的 payload type guard（Proto §1.1）——无 I/O。
 *
 * 从 gateway consumer.ts 下沉到 core（gateway 后续改为从此处 import——本轮不动 gateway）。
 * 语义与 consumer 现有实现一致，边界照抄（decision 三态白名单、options 非空且全合法、
 * notify.channel/target 必填字符串、signal 可选且形状严格）。
 * 用手写 type guard 而非 zod：这两个 payload 形状小而稳，且下沉目标 gateway 无直接 zod 依赖
 *   （见 toolchain-pitfalls §26），手写 guard 与 gateway 运行时环境无摩擦。
 */

/** decision 三态（§1 ActionButton.signal / §1.1）。 */
export type Decision = 'approve' | 'reject' | 'custom';
const DECISIONS: ReadonlySet<Decision> = new Set<Decision>(['approve', 'reject', 'custom']);

function isDecision(v: unknown): v is Decision {
  return typeof v === 'string' && DECISIONS.has(v as Decision);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** TaskCheckpointPayload（§1.1 L167-173）——task.checkpoint 事件的 payload 形状。 */
export interface TaskCheckpointPayload {
  taskId: string;
  checkpoint: string;
  prompt: string;
  options: Decision[];
  notify: { channel: string; target: string };
}

/** 解析 task.checkpoint payload；形状不符 → null（毒丸事件由调用方丢弃，不重投）。 */
export function parseTaskCheckpoint(payload: unknown): TaskCheckpointPayload | null {
  if (!isRecord(payload)) return null;
  const { taskId, checkpoint, prompt, options, notify } = payload;
  if (typeof taskId !== 'string' || typeof checkpoint !== 'string' || typeof prompt !== 'string') {
    return null;
  }
  if (!Array.isArray(options) || options.length === 0 || !options.every(isDecision)) return null;
  if (
    !isRecord(notify) ||
    typeof notify.channel !== 'string' ||
    typeof notify.target !== 'string'
  ) {
    return null;
  }
  return {
    taskId,
    checkpoint,
    prompt,
    options,
    notify: { channel: notify.channel, target: notify.target },
  };
}

/** ImActionSignal（§1.1 L175-179）——im.action 事件 payload.signal 的形状（signal 可选）。 */
export interface ImActionSignal {
  taskId: string;
  checkpoint: string;
  decision: Decision;
}

/** 解析 im.action 的 signal；无 signal / 形状不符 → null（非人类确认闭环，静默跳过）。 */
export function parseImActionSignal(payload: unknown): ImActionSignal | null {
  if (!isRecord(payload)) return null;
  const signal = payload.signal;
  if (!isRecord(signal)) return null; // 无 signal 或形状不符 → 非人类确认闭环。
  if (typeof signal.taskId !== 'string' || typeof signal.checkpoint !== 'string') return null;
  if (!isDecision(signal.decision)) return null;
  return { taskId: signal.taskId, checkpoint: signal.checkpoint, decision: signal.decision };
}
