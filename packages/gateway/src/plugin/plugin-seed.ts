/**
 * 内置 Plugin 种子（Proto §11 / Architecture M11）——把平台内置的 ChannelAdapter 作 PluginRegistry 条目注册。
 *
 * M11：Channel Adapter 是四类 Plugin 之一（ChannelAdapter 接口）。平台内置一个 channel-adapter：
 *   - webhook：通用 webhook 入站 adapter（gateway src/event/adapters/webhook.ts，§2.1 verify/decode 型）。
 * 其能力在平台内（endpoint="binding:<name>" 引用，非外部 HTTPS 服务）——注册为 built_in Plugin，使
 *   `watt plugin list` 能枚举内置 channel adapter、`watt plugin health` 对其返回 ok（M10 完备性 + PluginLifecycle）。
 *
 * 飞书（channel-feishu）**不再内置种子**（P1 飞书 plugin 化）：飞书是首个独立发行的 channel-adapter
 *   plugin（watt-plugin-feishu 独立 Worker，自持回调，Proto §2.1 自持回调型），经真实 `watt plugin register`
 *   （`watt setup feishu` 编排）注册，endpoint = plugin worker HTTPS URL——不再是 `binding:feishu` 占位。
 *
 * 幂等种子（仿 authz/seed.ts 的「get 不存在才 write」语义 + once-guard）：挂 platform/* 种子中间件，
 *   isolate 级短路，首次成功后不再打 D1。**只在条目不存在时写入**——已存在（含管理员经 Update 修改过
 *   enabled 等字段）的条目绝不覆写，否则任意新 isolate 冷启动都会把人工修改静默回滚回种子原值。
 */

import type { PluginManifest } from '@watt/core';
import type { PluginRegistry } from './plugin-registry.ts';

/** 内置 webhook ChannelAdapter（§2.1 verify/decode 型；入站验签 adapter）。 */
export const BUILTIN_WEBHOOK_PLUGIN: PluginManifest = {
  id: 'channel-webhook',
  kind: 'channel-adapter',
  interfaceVersion: 'channel-adapter/v1',
  endpoint: 'binding:webhook',
  auth: { kind: 'platform-token' },
  // 入站 adapter 把外部事件规约后 EventBus.Publish（回调平台）——需 event:// write。
  requiredGrants: [{ resources: ['event://'], actions: ['write'] }],
  healthPath: '/healthz',
  enabled: true,
};

/** 全部内置 Plugin 种子源（飞书不在此列——经 watt setup feishu 真实注册）。 */
export const BUILTIN_PLUGINS: PluginManifest[] = [BUILTIN_WEBHOOK_PLUGIN];

/**
 * 幂等种子内置 Plugin（引导时调）。**get 不存在才 write**（对齐 authz/seed.ts doSeed 语义）：
 *   已存在的条目（含管理员 Update 过的 enabled 状态）不覆写——无条件 upsert 会在每个新 isolate
 *   冷启动时把人工修改静默回滚（Round 7 策略种子同类缺陷的回归教训）。
 */
export async function seedBuiltinPlugins(registry: PluginRegistry): Promise<void> {
  for (const manifest of BUILTIN_PLUGINS) {
    const existing = await registry.get(manifest.id);
    if ('code' in existing) {
      await registry.write(manifest, true);
    }
  }
}

/** isolate 级短路缓存（同一 isolate 内已成功种子的 promise）。失败时置回 null 以保留重试。 */
let pluginsSeeded: Promise<void> | null = null;

/**
 * 幂等引导入口（挂 platform/* 种子中间件，仿 ensureManageDefsSeeded）：isolate 级短路，首次成功后不再打 D1。
 * 「get 不存在才 write」语义下短路失效重跑也安全（存在即跳过）。失败清缓存以便下次请求重试。
 */
export function ensureBuiltinPluginsSeeded(registry: PluginRegistry): Promise<void> {
  if (!pluginsSeeded) {
    pluginsSeeded = seedBuiltinPlugins(registry).catch((err) => {
      pluginsSeeded = null;
      throw err;
    });
  }
  return pluginsSeeded;
}

/** 测试专用：重置 isolate 级短路缓存（清库后须调，否则种子不再重建）。 */
export function resetPluginSeedGuardForTests(): void {
  pluginsSeeded = null;
}
