import { describe, expect, it } from 'vitest';
import { toolMountSchema, toolVirtualizeSchema } from './types.ts';

/**
 * Tool 类型层 zod schema 用例（test-first，Proto §5.2）。
 * 断言字段名/约束与 Proto 原文一致，且 schema 行被覆盖执行（core 100% 覆盖惯例）。
 */

describe('toolMountSchema（§5.2）', () => {
  it('接受最小挂载（path + provider + enabled）', () => {
    const m = toolMountSchema.parse({
      path: 'observability/logs',
      provider: 'http',
      enabled: true,
    });
    expect(m).toEqual({ path: 'observability/logs', provider: 'http', enabled: true });
  });

  it('接受完整挂载（providerConfig/virtualize）', () => {
    const m = toolMountSchema.parse({
      path: 'finance/reports',
      provider: 'mcp',
      providerConfig: { endpoint: 'https://mcp.example.com', secretRef: 'MCP_TOKEN' },
      virtualize: {
        prefix: 'fin',
        rename: { get_report: 'report' },
        hide: ['delete_all'],
        describeOverride: { report: 'Fetch a financial report' },
      },
      enabled: false,
    });
    expect(m.enabled).toBe(false);
    expect(m.providerConfig?.endpoint).toBe('https://mcp.example.com');
    expect(m.virtualize?.prefix).toBe('fin');
  });

  it('接受内置 provider（builtin）与 plugin id（开放集合，非 enum）', () => {
    expect(
      toolMountSchema.safeParse({ path: 'p', provider: 'builtin', enabled: true }).success,
    ).toBe(true);
    // plugin id 是开放集合——不被 enum 收窄拒绝。
    expect(
      toolMountSchema.safeParse({ path: 'p', provider: 'my-custom-plugin', enabled: true }).success,
    ).toBe(true);
  });

  it('缺 enabled → fail（必填）', () => {
    expect(toolMountSchema.safeParse({ path: 'p', provider: 'http' }).success).toBe(false);
  });

  it('缺 path/provider → fail（必填）', () => {
    expect(toolMountSchema.safeParse({ provider: 'http', enabled: true }).success).toBe(false);
    expect(toolMountSchema.safeParse({ path: 'p', enabled: true }).success).toBe(false);
  });

  it('拒绝未知键（strict）', () => {
    expect(
      toolMountSchema.safeParse({ path: 'p', provider: 'http', enabled: true, bogus: 1 }).success,
    ).toBe(false);
  });

  it('enabled 非 boolean → fail', () => {
    expect(toolMountSchema.safeParse({ path: 'p', provider: 'http', enabled: 'yes' }).success).toBe(
      false,
    );
  });
});

describe('toolVirtualizeSchema（§5.2 虚拟化四项）', () => {
  it('全字段可选，空对象合法', () => {
    expect(toolVirtualizeSchema.parse({})).toEqual({});
  });

  it('接受四项虚拟化字段', () => {
    const v = toolVirtualizeSchema.parse({
      prefix: 'ns',
      rename: { a: 'b' },
      hide: ['c'],
      describeOverride: { d: 'text' },
    });
    expect(v.hide).toEqual(['c']);
    expect(v.rename).toEqual({ a: 'b' });
  });

  it('拒绝未知键（strict）', () => {
    expect(toolVirtualizeSchema.safeParse({ bogus: true }).success).toBe(false);
  });

  it('rename 值必须为 string（Record<string,string>）', () => {
    expect(toolVirtualizeSchema.safeParse({ rename: { a: 1 } }).success).toBe(false);
  });

  it('hide 必须为 string 数组', () => {
    expect(toolVirtualizeSchema.safeParse({ hide: [1] }).success).toBe(false);
  });
});
