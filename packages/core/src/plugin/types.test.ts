import { describe, expect, it } from 'vitest';
import { pluginAuthSchema, pluginKindSchema, pluginManifestSchema } from './types.ts';

/**
 * Plugin 类型层 zod schema 用例（test-first，Proto §11.1/§11.2）。
 * 断言字段名/约束与 Proto 原文一致，且 schema 行被覆盖执行（core 100% 覆盖惯例）。
 */

const MANIFEST = {
  id: 'feishu-main',
  kind: 'channel-adapter' as const,
  interfaceVersion: 'channel-adapter/v1',
  endpoint: 'binding:builtin',
  auth: { kind: 'platform-token' as const },
  requiredGrants: [{ resources: ['event://outbound.message'], actions: ['write'] }],
  healthPath: '/health',
  enabled: true,
};

describe('pluginKindSchema（§11.1 四类）', () => {
  it('接受四个 Plugin 类型', () => {
    for (const k of ['context-provider', 'tool-provider', 'channel-adapter', 'agent-harness']) {
      expect(pluginKindSchema.safeParse(k).success).toBe(true);
    }
  });
  it('拒绝表外 kind（如 model-provider——新渠道不是 Plugin）', () => {
    expect(pluginKindSchema.safeParse('model-provider').success).toBe(false);
  });
});

describe('pluginAuthSchema（§11.1 auth 判别联合）', () => {
  it('platform-token 无 secretRef', () => {
    expect(pluginAuthSchema.parse({ kind: 'platform-token' })).toEqual({ kind: 'platform-token' });
  });
  it('bearer 需 secretRef', () => {
    expect(pluginAuthSchema.safeParse({ kind: 'bearer', secretRef: 'X' }).success).toBe(true);
    expect(pluginAuthSchema.safeParse({ kind: 'bearer' }).success).toBe(false);
  });
});

describe('pluginManifestSchema（§11.1）', () => {
  it('接受完整 manifest', () => {
    expect(pluginManifestSchema.parse(MANIFEST)).toEqual(MANIFEST);
  });

  it('接受 bearer auth + 多 requiredGrants', () => {
    const m = pluginManifestSchema.parse({
      ...MANIFEST,
      auth: { kind: 'bearer', secretRef: 'PLUGIN_KEY' },
      requiredGrants: [
        { resources: ['context://feedback/bugs'], actions: ['read', 'write'] },
        { resources: ['event://outbound.message'], actions: ['write'] },
      ],
    });
    expect(m.auth).toEqual({ kind: 'bearer', secretRef: 'PLUGIN_KEY' });
    expect(m.requiredGrants).toHaveLength(2);
  });

  it('缺必填字段 → fail', () => {
    for (const key of [
      'id',
      'kind',
      'interfaceVersion',
      'endpoint',
      'auth',
      'healthPath',
      'enabled',
    ]) {
      const partial: Record<string, unknown> = { ...MANIFEST };
      delete partial[key];
      expect(pluginManifestSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('enabled 非 boolean → fail', () => {
    expect(pluginManifestSchema.safeParse({ ...MANIFEST, enabled: 'yes' }).success).toBe(false);
  });

  it('requiredGrants 缺省不允许（必填数组，可为空 []）', () => {
    expect(pluginManifestSchema.safeParse({ ...MANIFEST, requiredGrants: [] }).success).toBe(true);
    const partial: Record<string, unknown> = { ...MANIFEST };
    delete partial.requiredGrants;
    expect(pluginManifestSchema.safeParse(partial).success).toBe(false);
  });
});
