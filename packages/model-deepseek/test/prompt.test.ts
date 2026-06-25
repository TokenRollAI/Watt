import { describe, expect, it } from 'vitest';
import {
  assemblePrompt,
  assertStablePrefix,
  assertStableTools,
  type FunctionToolDef,
} from '../src/index.js';

describe('prefix cache 纪律', () => {
  it('静态前缀含时间戳被拒', () => {
    expect(() => assertStablePrefix('当前时间 2026-06-12T10:30 处理任务')).toThrow(
      /volatile/,
    );
  });

  it('静态前缀含 ULID 被拒', () => {
    expect(() => assertStablePrefix('run 01KTX5FHN825SCPY4X18SA18R7')).toThrow(/volatile/);
  });

  it('纯静态文本通过', () => {
    expect(() => assertStablePrefix('你是调研 Agent，负责收集资料。')).not.toThrow();
  });

  it('assemblePrompt 把 system 放最前、易变内容追加在后', () => {
    const msgs = assemblePrompt('你是助手。', [
      { role: 'user', content: '现在时间 2026-06-12T10:30，请处理' },
    ]);
    expect(msgs[0]).toEqual({ role: 'system', content: '你是助手。' });
    expect(msgs).toHaveLength(2);
    // 易变内容允许出现在 system 之后的消息里，不被校验
    expect(msgs[1]?.content).toContain('2026-06-12');
  });

  it('assemblePrompt 拒绝含易变内容的 system 前缀', () => {
    expect(() =>
      assemblePrompt('系统启动于 2026-06-12T10:30', []),
    ).toThrow(/volatile/);
  });

  it('assertStableTools 校验工具定义（名/描述/参数）', () => {
    const stable: FunctionToolDef[] = [
      {
        type: 'function',
        function: {
          name: 'finish',
          description: '提交最终结果',
          parameters: { type: 'object', properties: { summary: { type: 'string' } } },
        },
      },
    ];
    expect(() => assertStableTools(stable)).not.toThrow();

    const volatileTool: FunctionToolDef[] = [
      {
        type: 'function',
        function: {
          name: 'finish',
          description: '由 01KTX5FHN825SCPY4X18SA18R7 注入',
          parameters: {},
        },
      },
    ];
    expect(() => assertStableTools(volatileTool)).toThrow(/volatile/);
  });
});
