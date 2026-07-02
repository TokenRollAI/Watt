import { describe, expect, it } from 'vitest';
import { toolActionFor } from './tool-action.ts';

/**
 * §6.4d 工具动作映射：ToolSpec.scope 存在 → action = scope 字符串；否则 "invoke"。
 * oracle 硬编码字符串，不 import 被测常量。
 */
describe('toolActionFor (§6.4d)', () => {
  it('J1 uses scope string as action when scope present', () => {
    expect(toolActionFor('finance.read')).toBe('finance.read');
  });

  it('J2 falls back to "invoke" when scope absent (undefined)', () => {
    expect(toolActionFor(undefined)).toBe('invoke');
  });

  it('J3 empty-string scope also falls back to "invoke"', () => {
    expect(toolActionFor('')).toBe('invoke');
  });
});
