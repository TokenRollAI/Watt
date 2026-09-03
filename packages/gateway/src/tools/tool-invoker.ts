/**
 * Tool 消费面调用核心。
 *
 * Watt 仍负责 ToolRegistry、用户鉴权和可见性裁剪；Tool Bridge 的树同步、解析和调用统一通过
 * Tool Bridge Host SDK 完成。
 */

import {
  createToolBridgeHost,
  type HostMount,
  serviceBinding,
  type ToolBridgeHost,
} from '@tokenroll/tool-bridge/host';
import type { ToolMount } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import type { Bindings } from '../env.ts';
import { ToolRegistry } from './tool-registry.ts';

export function isWattError(v: unknown): v is WattError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v && 'retryable' in v;
}

/** 旧树节点投影，仅保留给测试/兼容导出；新链路不再把树写入 Watt KV。 */
interface TreeNode {
  type: string;
  id: string;
  title?: string;
  children?: TreeNode[];
  [k: string]: unknown;
}

function mountToLeaf(mount: ToolMount, id: string): TreeNode {
  const cfg = (mount.providerConfig ?? {}) as Record<string, unknown>;
  const node: TreeNode = { type: mount.provider, id, ...cfg };
  node.id = id;
  node.type = mount.provider;
  if (mount.virtualize?.prefix !== undefined) node.namespace = mount.virtualize.prefix;
  return node;
}

export function buildUpstreamTree(mounts: ToolMount[]): TreeNode {
  const root: TreeNode = { type: 'directory', id: 'root', title: 'Watt Tools', children: [] };
  for (const mount of mounts) {
    if (!mount.enabled) continue;
    const segs = mount.path.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i] as string;
      let child = dir.children?.find((c) => c.id === seg && c.type === 'directory');
      if (!child) {
        child = { type: 'directory', id: seg, children: [] };
        dir.children = dir.children ?? [];
        dir.children.push(child);
      }
      dir = child;
    }
    const leafId = segs[segs.length - 1] as string;
    dir.children = dir.children ?? [];
    const existing = dir.children.findIndex((c) => c.id === leafId);
    const leaf = mountToLeaf(mount, leafId);
    if (existing >= 0) dir.children[existing] = leaf;
    else dir.children.push(leaf);
  }
  return root;
}

let lastMountsHash: string | undefined;

export function resetSyncStateForTests(): void {
  lastMountsHash = undefined;
}

function hostId(env: Bindings): string {
  return env.WATT_TOOLBRIDGE_HOST_ID || 'watt';
}

function hostCredential(env: Bindings): string | undefined {
  return env.WATT_TOOLBRIDGE_HOST_KEY || env.WATT_TOOLBRIDGE_KEY || env.WATT_TOOLBRIDGE_ADMIN_KEY;
}

function toolBridgeHost(env: Bindings): ToolBridgeHost {
  return createToolBridgeHost({
    transport: serviceBinding(env.TOOLBRIDGE),
    credential: hostCredential(env),
    hostId: hostId(env),
  });
}

function hashStable(value: unknown): Promise<string> {
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
    .then((digest) =>
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    );
}

function toolOverridesFor(
  virtualize: ToolMount['virtualize'],
): Record<string, Record<string, unknown>> | undefined {
  if (!virtualize) return undefined;
  const overrides: Record<string, Record<string, unknown>> = {};
  const ensure = (name: string): Record<string, unknown> => {
    overrides[name] = overrides[name] ?? {};
    return overrides[name];
  };
  for (const [from, to] of Object.entries(virtualize.rename ?? {})) {
    ensure(from).rename = to;
  }
  for (const name of virtualize.hide ?? []) {
    ensure(name).hide = true;
  }
  for (const [name, description] of Object.entries(virtualize.describeOverride ?? {})) {
    ensure(name).description = description;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function namedSemanticsFromConfig(
  cfg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (cfg.semantics && typeof cfg.semantics === 'object' && !Array.isArray(cfg.semantics)) {
    return cfg.semantics as Record<string, unknown>;
  }

  const effect = typeof cfg.effect === 'string' ? cfg.effect : undefined;
  const scope = typeof cfg.scope === 'string' ? cfg.scope : undefined;
  const confirm = cfg.confirm === true ? true : undefined;
  if (!effect && !scope && !confirm) return undefined;

  const semantics: Record<string, Record<string, unknown>> = {};
  const add = (name: unknown) => {
    if (typeof name !== 'string' || name.length === 0) return;
    semantics[name] = {
      ...(effect ? { effect } : {}),
      ...(scope ? { scope } : {}),
      ...(confirm ? { confirm } : {}),
    };
  };
  for (const item of Array.isArray(cfg.endpoints) ? cfg.endpoints : []) {
    if (item && typeof item === 'object') add((item as { name?: unknown }).name);
  }
  for (const item of Array.isArray(cfg.tools) ? cfg.tools : []) {
    if (item && typeof item === 'object') add((item as { name?: unknown }).name);
  }
  if (Object.keys(semantics).length === 0) semantics.call = { effect, scope, confirm };
  return semantics;
}

export function mountToHostMount(mount: ToolMount): HostMount | undefined {
  if (!mount.enabled) return undefined;
  const cfg = (mount.providerConfig ?? {}) as Record<string, unknown>;
  const binding = { ...cfg, type: mount.provider };
  binding.type = mount.provider;

  const shaping: Record<string, unknown> = {};
  if (mount.virtualize?.prefix) shaping.namespace = mount.virtualize.prefix;
  const toolOverrides = toolOverridesFor(mount.virtualize);
  if (toolOverrides) shaping.toolOverrides = toolOverrides;

  const result: HostMount = {
    path: mount.path.replace(/^\/+|\/+$/g, ''),
    binding,
  };
  if (typeof cfg.version === 'string') result.version = cfg.version;
  if (Object.keys(shaping).length > 0) result.shaping = shaping;
  const semantics = namedSemanticsFromConfig(cfg);
  if (semantics) result.semantics = semantics;
  return result;
}

export function mountsToHostMounts(mounts: ToolMount[]): HostMount[] {
  return mounts.map(mountToHostMount).filter((m): m is HostMount => m !== undefined);
}

async function syncToolBridgeMounts(env: Bindings): Promise<WattError | undefined> {
  if (!hostCredential(env)) {
    return wattError('unavailable', 'Tool Bridge key is not configured', false);
  }

  const registry = new ToolRegistry(env.DB_PROVIDERS);
  const page = await registry.list({ limit: 200 });
  if (isWattError(page)) return page;

  const mounts = mountsToHostMounts(page.items);
  const hash = await hashStable(mounts);
  if (hash === lastMountsHash) return undefined;

  try {
    await toolBridgeHost(env).mounts.sync(mounts, { prune: true });
    lastMountsHash = hash;
    return undefined;
  } catch (error) {
    return convertToolBridgeError(env, error);
  }
}

export async function trimHelpVisibility(
  body: unknown,
  basePath: string,
  check: (resource: string) => Promise<boolean>,
): Promise<unknown> {
  if (typeof body !== 'object' || body === null) return body;
  const help = body as { resources?: Array<{ name: string; path: string }> };
  if (!Array.isArray(help.resources)) return body;
  const kept: Array<{ name: string; path: string }> = [];
  for (const res of help.resources) {
    const childSeg = res.path.replace(/^\.\//, '').replace(/^\/+/, '');
    const childPath = basePath ? `${basePath}/${childSeg}` : childSeg;
    if (await check(`tool://${childPath}`)) kept.push(res);
  }
  return { ...help, resources: kept };
}

async function resolveMount(
  registry: ToolRegistry,
  toolPath: string,
): Promise<ToolMount | undefined> {
  const segs = toolPath.split('/').filter((s) => s.length > 0);
  for (let end = segs.length; end >= 1; end--) {
    const candidate = segs.slice(0, end).join('/');
    const mount = await registry.get(candidate);
    if (!isWattError(mount)) return mount;
  }
  return undefined;
}

function parseCallBody(
  rawBody: string,
  provider: string | undefined,
): { ok: true; body: unknown } | { ok: false; error: WattError } {
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return {
      ok: false,
      error: wattError('invalid_argument', 'tool call body must be valid JSON', false),
    };
  }
  if (
    provider === 'http' &&
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'arguments' in parsed
  ) {
    return { ok: true, body: (parsed as { arguments?: unknown }).arguments ?? {} };
  }
  return { ok: true, body: parsed ?? {} };
}

function convertToolBridgeError(env: Bindings, error: unknown): WattError {
  return toolBridgeHost(env).adapters.wattError()(error) as WattError;
}

async function convertToolBridgeResponseError(
  env: Bindings,
  response: Response,
): Promise<WattError> {
  let code = 'internal_error';
  let message = `HTTP ${response.status}`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
    details = body.error?.details;
  } catch {
    // keep status-derived defaults
  }
  const { TBApiError } = await import('@tokenroll/tool-bridge');
  return convertToolBridgeError(env, new TBApiError(code, response.status, message, details));
}

export interface ToolInvokeRequest {
  toolPath: string;
  op: 'help' | 'skill' | 'call';
  rawBody?: string;
  accept?: string;
}

export type ToolInvokeResult =
  | { ok: true; kind: 'json'; body: unknown }
  | { ok: true; kind: 'text'; contentType: string; text: string }
  | { ok: false; error: WattError };

export interface ToolInvokeOpts {
  trim?: (resource: string) => Promise<boolean>;
}

async function readSkillViaTransport(
  env: Bindings,
  path: string,
  accept: string | undefined,
): Promise<Response> {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const suffix = clean ? `/${clean}` : '';
  return serviceBinding(env.TOOLBRIDGE).fetch(`/htbp${suffix}/~skill`, {
    method: 'GET',
    headers: {
      ...(hostCredential(env) ? { Authorization: `Bearer ${hostCredential(env)}` } : {}),
      ...(accept ? { Accept: accept } : {}),
    },
  });
}

export async function executeToolRequest(
  env: Bindings,
  req: ToolInvokeRequest,
  opts: ToolInvokeOpts = {},
): Promise<ToolInvokeResult> {
  const syncError = await syncToolBridgeMounts(env);
  if (syncError) return { ok: false, error: syncError };

  const client = toolBridgeHost(env);

  try {
    if (req.op === 'call') {
      const registry = new ToolRegistry(env.DB_PROVIDERS);
      const mount = await resolveMount(registry, req.toolPath);
      const parsed = parseCallBody(req.rawBody ?? '', mount?.provider);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, kind: 'json', body: await client.tree.call(req.toolPath, parsed.body) };
    }

    if (req.op === 'skill') {
      const response = await readSkillViaTransport(env, req.toolPath, req.accept);
      if (!response.ok) {
        return { ok: false, error: await convertToolBridgeResponseError(env, response) };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
        return { ok: true, kind: 'text', contentType, text: await response.text() };
      }
      return { ok: true, kind: 'json', body: await response.json() };
    }

    const wantsText = req.accept?.includes('text/plain') === true;
    const body = await client.tree.help(req.toolPath, { accept: wantsText ? 'text' : 'json' });
    if (typeof body === 'string') {
      return { ok: true, kind: 'text', contentType: 'text/plain; charset=utf-8', text: body };
    }
    return {
      ok: true,
      kind: 'json',
      body: opts.trim ? await trimHelpVisibility(body, req.toolPath, opts.trim) : body,
    };
  } catch (error) {
    return { ok: false, error: convertToolBridgeError(env, error) };
  }
}
