/**
 * `watt secret set|list|rm`：POST /htbp/platform/secret `{tool,arguments}`（Proto §6.6 SecretStore）。
 *
 * tool 名对齐 gateway 现状（packages/gateway/src/http/routes.ts）：List / Write / Delete。
 *  - set  → tool:"Write"，arguments:{name,value}（value 从 stdin/TTY 读，**绝不走 argv** 防 shell history）
 *  - list → tool:"List"（返回 {items:[{name,updatedAt,shadowedByEnv}]}）
 *  - rm   → tool:"Delete"，arguments:{name}
 *
 * 响应形状真源 = gateway 路由测试（toolchain §34，禁双形态兜底）：
 *   List → { items:[SecretMeta] }；Write → { secret:{name,updatedAt} }（永不回显 value）；Delete → { deleted:true }。
 */

import { type HttpDeps, htbpCall } from './client.ts';

/** secret 元数据（对外只出这些字段——永不含明文值）。 */
export interface SecretMeta {
  name: string;
  updatedAt: string;
  shadowedByEnv: boolean;
}

/** 设置（写入/覆写）一个 secret。value 由调用方从 stdin/TTY 读取传入。返回元数据（无 value）。 */
export async function secretSet(
  base: string,
  token: string,
  name: string,
  value: string,
  deps: HttpDeps = {},
): Promise<{ name: string; updatedAt: string }> {
  const body = (await htbpCall(base, token, 'secret', 'Write', { name, value }, deps)) as {
    secret: { name: string; updatedAt: string };
  };
  return body.secret;
}

/** 列出全部 secret 元数据（永不含明文值）。 */
export async function secretList(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<SecretMeta[]> {
  const body = (await htbpCall(base, token, 'secret', 'List', {}, deps)) as {
    items: SecretMeta[];
  };
  return body.items;
}

/** 删除一个 secret（幂等）。 */
export async function secretRm(
  base: string,
  token: string,
  name: string,
  deps: HttpDeps = {},
): Promise<{ deleted: true }> {
  return (await htbpCall(base, token, 'secret', 'Delete', { name }, deps)) as { deleted: true };
}

export function formatSecretListHuman(secrets: SecretMeta[]): string {
  if (!secrets.length) return '(no secrets)';
  return secrets
    .map((s) => `${s.name}\t${s.updatedAt}${s.shadowedByEnv ? '\t[shadowed-by-env]' : ''}`)
    .join('\n');
}
