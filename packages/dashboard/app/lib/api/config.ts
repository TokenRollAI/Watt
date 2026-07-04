/**
 * 视图族E（Secrets/Channels/Providers/Plugins/Settings）补充 wrapper。
 *
 * platform.ts 已覆盖 Secret/Channel/Provider 全部动作与 plugin List/Get/Health；本文件只补 platform.ts
 * **形状不对**的一处：plugin Write 的注册响应。
 *
 * plugin Write 真源响应（gateway routes.ts:1424 + cli/src/plugin.ts）= `{ registration: {...manifest,
 *   platformBaseUrl, jwksUrl, pluginToken} }`——pluginToken 仅注册响应回传一次（List/Get 不回显）。
 * platform.ts 的 registerPlugin 声明为 `{plugin, pluginToken?}`，与真源不符（拿不到 registration.pluginToken）。
 * platform.ts 属禁改文件，故此处以正确形状重新实现，视图层从本文件导入 registerPlugin。
 */

import { htbp } from './core.ts';
import type { PluginManifest } from './types.ts';

/** plugin Write 注册响应（§11.2 PluginRegistration）——manifest + 回调对接三件套。 */
export interface PluginRegistration extends PluginManifest {
  platformBaseUrl: string;
  jwksUrl: string;
  /** 仅注册响应回传一次，之后永不回显——视图层展示后须提示保存。 */
  pluginToken: string;
}

/**
 * plugin register → PluginRegistry.Write → { registration }。
 * 精确解包 registration（真源单形态，缺则视为契约漂移抛错——不双形态兜底，§34）。
 */
export async function registerPlugin(
  manifest: Record<string, unknown>,
): Promise<PluginRegistration> {
  const body = await htbp<{ registration?: PluginRegistration }>('plugin', 'Write', { manifest });
  if (body.registration === undefined) {
    throw new Error('注册响应缺少 registration 字段（服务端契约漂移）');
  }
  return body.registration;
}
