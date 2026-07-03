import { type WattError, wattError } from '@watt/shared';

/**
 * Cron 表达式解析（Proto §7 CronJob.schedule L755）——无 I/O，UTC 语义。
 *
 * schedule 两种形态（§7 L755）：分钟级五段 cron 表达式（UTC），或 ISO 8601 时刻（一次性）。
 *
 * 实现自由决策（纪律 4 已核实）：agents 包的 `agents/schedule` 只导出 scheduleSchema（给 LLM
 *   生成用的 zod schema，把 cron 当 z.string() 透传），其内部 getNextCronTime 走第三方
 *   cron-schedule 库但**未导出为纯函数**。core 是零运行时依赖的纯逻辑包，引入 cron-schedule
 *   会（a）支持完整 cron 语法，超出 §7 的分钟级子集，需额外声明拒绝面；（b）给 core 加运行时
 *   依赖，违背其设计；（c）其 getNextDate 需额外适配 UTC。故**手写规范所需的分钟级子集**，
 *   边界更可控、100% 覆盖更易达成。
 *
 * 支持的 cron 子集（每段声明）：五段 `分 时 日 月 周`，每段允许：
 *   - `*`（通配，匹配全部）
 *   - 数字（单值，按段范围校验）
 *   - `a,b,c`（列表，各元素按单值/范围校验）
 *   - `a-b`（闭区间范围，a ≤ b）
 *   - `*​/n`（步进：从段最小值起每 n 步，n ≥ 1）
 * **不支持**：`a-b/n` 组合步进、`?`、`L`/`W`/`#` 等扩展语法、名称（JAN/MON）、秒段——
 *   遇到即 invalid_argument（保持子集边界清晰）。
 */

/** 五段各自的取值范围（分钟级 UTC；周 0-6，0=周日）。 */
const FIELD_RANGES: ReadonlyArray<{ min: number; max: number; name: string }> = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day-of-month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 6, name: 'day-of-week' },
];

/** 解析结果：cron（五段允许值集合）或 once（一次性 ISO 时刻）。 */
export interface ParsedCron {
  kind: 'cron';
  /** 五段各自的允许取值集合（升序去重），下标 0=分 1=时 2=日 3=月 4=周。 */
  fields: number[][];
}
export interface ParsedOnce {
  kind: 'once';
  /** 一次性触发的 ISO 8601 时刻（原样保留输入）。 */
  at: string;
}
export type ParsedSchedule = ParsedCron | ParsedOnce;

/** 解析单个 cron 段为允许值集合（升序去重）。非法子集语法 → null。 */
function parseField(token: string, range: { min: number; max: number }): number[] | null {
  const all: number[] = [];
  for (let v = range.min; v <= range.max; v++) all.push(v);

  // 步进 `*​/n`（仅支持基于 `*` 的步进，不支持 `a-b/n`）。
  if (token.startsWith('*/')) {
    const n = Number(token.slice(2));
    if (!Number.isInteger(n) || n < 1) return null;
    return all.filter((_v, i) => i % n === 0);
  }

  // `*` 通配。
  if (token === '*') return all;

  // 列表 / 范围 / 单值。
  const set = new Set<number>();
  for (const part of token.split(',')) {
    if (part.length === 0) return null; // 空片段（如 "1,,2" 或尾逗号）非法。
    if (part.includes('-')) {
      const bounds = part.split('-');
      if (bounds.length !== 2) return null;
      const lo = Number(bounds[0]);
      const hi = Number(bounds[1]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      if (lo < range.min || hi > range.max || lo > hi) return null;
      for (let v = lo; v <= hi; v++) set.add(v);
    } else {
      const v = Number(part);
      if (!Number.isInteger(v) || v < range.min || v > range.max) return null;
      set.add(v);
    }
  }
  return [...set].sort((a, b) => a - b);
}

// ISO 8601 时刻的最小判定：能被 Date.parse 解析且含 'T'（区分纯日期与时刻），非五段 cron。
function tryParseOnce(schedule: string): ParsedOnce | null {
  if (!schedule.includes('T')) return null;
  const ms = Date.parse(schedule);
  if (Number.isNaN(ms)) return null;
  return { kind: 'once', at: schedule };
}

/**
 * 解析 schedule 字符串（§7）。
 * - 含 'T' 且可被 Date 解析 → once（一次性 ISO 时刻）；
 * - 恰五段且各段合法子集 → cron；
 * - 其余 → invalid_argument WattError。
 */
export function parseCronSchedule(schedule: string): ParsedSchedule | WattError {
  const trimmed = schedule.trim();
  if (trimmed.length === 0) {
    return wattError('invalid_argument', 'schedule must not be empty', false);
  }

  const once = tryParseOnce(trimmed);
  if (once !== null) return once;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    return wattError(
      'invalid_argument',
      `cron schedule must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${tokens.length}`,
      false,
    );
  }

  const fields: number[][] = [];
  for (const [i, range] of FIELD_RANGES.entries()) {
    const token = tokens[i] as string; // 长度已校验为 5，下标 0-4 必存在。
    const parsed = parseField(token, range);
    if (parsed === null) {
      return wattError(
        'invalid_argument',
        `invalid cron ${range.name} field '${token}' (supported subset: *, N, a-b, a,b, */n)`,
        false,
      );
    }
    fields.push(parsed);
  }
  return { kind: 'cron', fields };
}

/**
 * 计算下次触发时刻（UTC 毫秒）。
 * - once：at 时刻 > fromMs 返其毫秒；已过期（≤ fromMs）返 null。
 * - cron：从 fromMs 的下一分钟起逐分钟向前搜，命中五段（分/时/日/月/周同时匹配）的首个时刻。
 *   周与日为「或」不适用（本子集不支持 `?`）——采用标准 cron 语义：日和周均非 `*` 时取并集，
 *   否则取交集。为保守且可测，此处按**交集**判定（日与周都需匹配）；若需并集语义由 §7 未强制，
 *   声明取交集（更严格，模板可用纯日或纯周表达式规避歧义）。
 * 搜索上限 4 年（跨闰年周期上界），超出返 null（防御非法组合如 2 月 30 日）。
 */
export function nextFireTime(parsed: ParsedSchedule, fromMs: number): number | null {
  if (parsed.kind === 'once') {
    const at = Date.parse(parsed.at);
    if (Number.isNaN(at)) return null;
    return at > fromMs ? at : null;
  }

  const [minutes, hours, days, months, weekdays] = parsed.fields;
  const minSet = new Set(minutes);
  const hourSet = new Set(hours);
  const daySet = new Set(days);
  const monthSet = new Set(months);
  const weekdaySet = new Set(weekdays);

  // 从 fromMs 的下一分钟起（清零秒/毫秒），逐分钟搜。
  const start = new Date(fromMs);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const MAX_MINUTES = 4 * 366 * 24 * 60; // 4 年上界（含闰年余量）。
  const cursor = start;
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (
      minSet.has(cursor.getUTCMinutes()) &&
      hourSet.has(cursor.getUTCHours()) &&
      daySet.has(cursor.getUTCDate()) &&
      monthSet.has(cursor.getUTCMonth() + 1) &&
      weekdaySet.has(cursor.getUTCDay())
    ) {
      return cursor.getTime();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
