/**
 * prompt 组装辅助：强制 prefix cache 纪律。
 *
 * DeepSeek 自动 prefix cache：当请求与近期请求共享相同前缀时，命中段从磁盘
 * 取回并按 cache-hit 低价计费。要稳定命中，静态前缀（system prompt、工具
 * 定义）必须逐字节稳定且排在最前；时间戳 / 随机 id / 每轮变化的内容绝不能
 * 进入前缀，否则前缀每次都不同、永远 miss。
 *
 * 本模块只做组装与轻量校验，不发请求。messages 数组的前缀稳定性由调用方
 * 保证：把不变的 system 段放最前，易变内容（用户输入、工具结果）追加在后。
 */

import type { ChatMessage, FunctionToolDef, SystemMessage } from './types.js';

/** 一眼可见的易变标记：出现在前缀里几乎必然破坏 cache。 */
const VOLATILE_PATTERNS: RegExp[] = [
  // ISO-8601 时间戳
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
  // ULID（protocol id 尾部）
  /\b[0-9A-HJKMNP-TV-Z]{26}\b/,
  // UUID
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
];

/**
 * 校验静态前缀文本不含易变内容。命中 VOLATILE_PATTERNS 即抛错——
 * 把 cache 破坏暴露在组装期，而非默默吃高价。
 */
export function assertStablePrefix(text: string): void {
  for (const re of VOLATILE_PATTERNS) {
    if (re.test(text)) {
      throw new Error(
        `static prefix contains volatile content (matched ${re}); ` +
          'timestamps/random ids must not enter the prompt prefix',
      );
    }
  }
}

/**
 * 组装一次调用的 messages，强制"静态前缀在前"。
 *
 * @param systemPrompt 静态 system prompt（职责、约束）——前缀的一部分，会被
 *   校验不含易变内容。
 * @param dynamic 易变消息序列（用户输入、历史、工具结果），追加在前缀之后。
 *
 * 工具定义同属静态前缀，但 OpenAI 兼容 API 里 tools 是独立字段（见
 * assertStableTools），不混进 messages。
 */
export function assemblePrompt(
  systemPrompt: string,
  dynamic: ChatMessage[],
): ChatMessage[] {
  assertStablePrefix(systemPrompt);
  const system: SystemMessage = { role: 'system', content: systemPrompt };
  return [system, ...dynamic];
}

/**
 * 校验工具定义前缀稳定：工具名、描述、参数 schema 不应含易变内容。
 * 工具定义是 prefix cache 的一部分，每轮必须逐字节一致。
 */
export function assertStableTools(tools: FunctionToolDef[]): void {
  for (const t of tools) {
    assertStablePrefix(t.function.name);
    if (t.function.description) assertStablePrefix(t.function.description);
    assertStablePrefix(JSON.stringify(t.function.parameters));
  }
}
