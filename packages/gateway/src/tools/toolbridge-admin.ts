import { createToolBridgeAdmin, serviceBinding } from '@tokenroll/tool-bridge/admin';
import { type WattError, wattError } from '@watt/shared';
import type { Bindings } from '../env.ts';

type Args = Record<string, unknown>;

export const TOOLBRIDGE_ADMIN_ACTIONS: Record<string, 'read' | 'manage'> = {
  AuthConfig: 'read',
  ProvidersList: 'read',
  ProvidersGet: 'read',
  ProvidersCreate: 'manage',
  ProvidersUpdate: 'manage',
  ProvidersDelete: 'manage',
  ProvidersCreateKey: 'manage',
  PublicationsList: 'read',
  PublicationsGet: 'read',
  PublicationsCreate: 'manage',
  PublicationsUpdate: 'manage',
  PublicationsDelete: 'manage',
  PublicationsPublish: 'manage',
  PlacementsList: 'read',
  PlacementsPut: 'manage',
  PlacementsDryRun: 'read',
  PlacementsDelete: 'manage',
  HostsCreate: 'manage',
  HostsGet: 'read',
  HostsCreateKey: 'manage',
  EndpointsList: 'read',
  EndpointsCreate: 'manage',
  EndpointsGet: 'read',
  EndpointsUpdate: 'manage',
  EndpointsRevoke: 'manage',
  CommandPoliciesList: 'read',
  CommandPoliciesCreate: 'manage',
  CommandPoliciesGet: 'read',
  CommandPoliciesUpdate: 'manage',
  CommandPoliciesDelete: 'manage',
  AuditEvents: 'read',
  ServersList: 'read',
  ServersCreate: 'manage',
  ServersDelete: 'manage',
  ServersGet: 'read',
  ServersTools: 'read',
  ServersHelp: 'read',
  ServersSkill: 'read',
  ServersCall: 'manage',
  BridgeTools: 'read',
  BridgeCall: 'manage',
  TreeGet: 'read',
  TreeCrawl: 'read',
  TreeHelp: 'read',
  TreeCall: 'manage',
};

function str(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw wattError('invalid_argument', `${key} is required`, false);
  }
  return value;
}

function obj<T extends Record<string, unknown>>(args: Args, key: string): T {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw wattError('invalid_argument', `${key} is required`, false);
  }
  return value as T;
}

function optObj<T extends Record<string, unknown>>(args: Args, key: string): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw wattError('invalid_argument', `${key} must be an object`, false);
  }
  return value as T;
}

function credential(env: Bindings): string | WattError {
  const key =
    env.WATT_TOOLBRIDGE_ADMIN_KEY || env.WATT_TOOLBRIDGE_KEY || env.WATT_TOOLBRIDGE_HOST_KEY;
  if (!key) {
    return wattError('unavailable', 'Tool Bridge key is not configured', false);
  }
  return key;
}

export function convertToolBridgeAdminError(error: unknown): WattError {
  if (isWattError(error)) return error;
  const e =
    error && typeof error === 'object'
      ? (error as { status?: number; code?: string; message?: string; retryable?: boolean })
      : {};
  const code =
    e.status === 400
      ? 'invalid_argument'
      : e.status === 401
        ? 'permission_denied'
        : e.status === 403
          ? 'permission_denied'
          : e.status === 404
            ? 'not_found'
            : e.status === 502 || e.status === 503
              ? 'unavailable'
              : 'internal';
  return wattError(code, e.message ?? String(error), e.retryable === true);
}

function isWattError(v: unknown): v is WattError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v && 'retryable' in v;
}

export async function executeToolBridgeAdmin(
  env: Bindings,
  tool: string,
  args: Args,
): Promise<unknown | WattError> {
  const key = credential(env);
  if (isWattError(key)) return key;
  const admin = createToolBridgeAdmin({
    transport: serviceBinding(env.TOOLBRIDGE),
    credential: key,
  });

  try {
    switch (tool) {
      case 'AuthConfig':
        return { config: await admin.auth.config() };

      case 'ProvidersList':
        return { providers: await admin.providers.list() };
      case 'ProvidersGet':
        return { provider: await admin.providers.get(str(args, 'id')) };
      case 'ProvidersCreate':
        return { provider: await admin.providers.create(obj(args, 'provider')) };
      case 'ProvidersUpdate':
        return { provider: await admin.providers.update(str(args, 'id'), obj(args, 'patch')) };
      case 'ProvidersDelete':
        await admin.providers.delete(str(args, 'id'));
        return { deleted: true };
      case 'ProvidersCreateKey':
        return admin.providers.createKey(str(args, 'id'), optObj(args, 'opts') ?? {});

      case 'PublicationsList':
        return { publications: await admin.publications.list(str(args, 'providerId')) };
      case 'PublicationsGet':
        return {
          publication: await admin.publications.get(str(args, 'providerId'), str(args, 'pubId')),
        };
      case 'PublicationsCreate':
        return {
          publication: await admin.publications.create(
            str(args, 'providerId'),
            obj(args, 'publication'),
          ),
        };
      case 'PublicationsUpdate':
        return {
          publication: await admin.publications.update(
            str(args, 'providerId'),
            str(args, 'pubId'),
            obj(args, 'patch'),
          ),
        };
      case 'PublicationsDelete':
        await admin.publications.delete(str(args, 'providerId'), str(args, 'pubId'));
        return { deleted: true };
      case 'PublicationsPublish':
        return {
          publication: await admin.publications.publish(
            str(args, 'providerId'),
            str(args, 'pubId'),
          ),
        };

      case 'PlacementsList':
        return {
          placements: await admin.placements.list(
            typeof args.tenantId === 'string' ? args.tenantId : undefined,
          ),
        };
      case 'PlacementsPut':
        return admin.placements.put(
          obj(args, 'placement') as unknown as Parameters<typeof admin.placements.put>[0],
        );
      case 'PlacementsDryRun':
        return admin.placements.dryRun(
          obj(args, 'placement') as unknown as Parameters<typeof admin.placements.dryRun>[0],
        );
      case 'PlacementsDelete':
        await admin.placements.delete(
          str(args, 'id'),
          typeof args.tenantId === 'string' ? args.tenantId : undefined,
          optObj(args, 'opts') ?? {},
        );
        return { deleted: true };

      case 'HostsCreate':
        return { host: await admin.hosts.create(obj(args, 'host')) };
      case 'HostsGet':
        return { host: await admin.hosts.get(str(args, 'id')) };
      case 'HostsCreateKey':
        return admin.hosts.createKey(str(args, 'id'), optObj(args, 'opts') ?? {});

      case 'EndpointsList':
        return { endpoints: await admin.endpoints.list() };
      case 'EndpointsCreate':
        return {
          endpoint: await admin.endpoints.create(
            obj(args, 'endpoint') as unknown as Parameters<typeof admin.endpoints.create>[0],
          ),
        };
      case 'EndpointsGet':
        return { endpoint: await admin.endpoints.get(str(args, 'id')) };
      case 'EndpointsUpdate':
        return { endpoint: await admin.endpoints.update(str(args, 'id'), obj(args, 'patch')) };
      case 'EndpointsRevoke':
        return { endpoint: await admin.endpoints.revoke(str(args, 'id')) };

      case 'CommandPoliciesList':
        return { policies: await admin.commandPolicies.list() };
      case 'CommandPoliciesCreate':
        return { policy: await admin.commandPolicies.create(obj(args, 'policy')) };
      case 'CommandPoliciesGet':
        return { policy: await admin.commandPolicies.get(str(args, 'id')) };
      case 'CommandPoliciesUpdate':
        return { policy: await admin.commandPolicies.update(str(args, 'id'), obj(args, 'patch')) };
      case 'CommandPoliciesDelete':
        await admin.commandPolicies.delete(str(args, 'id'));
        return { deleted: true };

      case 'AuditEvents':
        return admin.audit.events(optObj(args, 'opts') ?? {});

      case 'ServersList':
        return admin.servers.list();
      case 'ServersCreate':
        return admin.servers.create(obj(args, 'server'));
      case 'ServersDelete':
        await admin.servers.delete(str(args, 'id'));
        return { deleted: true };
      case 'ServersGet':
        return admin.servers.get(str(args, 'id'));
      case 'ServersTools':
        return admin.servers.tools(str(args, 'id'));
      case 'ServersHelp':
        return { text: await admin.servers.help(str(args, 'id')) };
      case 'ServersSkill':
        return { text: await admin.servers.skill(str(args, 'id')) };
      case 'ServersCall':
        return admin.servers.call(str(args, 'id'), str(args, 'toolName'), args.arguments ?? {});

      case 'BridgeTools':
        return admin.bridge.tools(
          obj(args, 'server') as unknown as Parameters<typeof admin.bridge.tools>[0],
        );
      case 'BridgeCall':
        return admin.bridge.call(
          obj(args, 'server') as unknown as Parameters<typeof admin.bridge.call>[0],
          str(args, 'toolName'),
          args.arguments ?? {},
        );

      case 'TreeGet':
        return { tree: await admin.tree.get() };
      case 'TreeCrawl':
        return { tree: await admin.tree.crawl(optObj(args, 'opts') ?? {}) };
      case 'TreeHelp':
        return { help: await admin.tree.help(typeof args.path === 'string' ? args.path : '') };
      case 'TreeCall':
        return admin.tree.call(str(args, 'path'), args.body ?? {});

      default:
        return wattError('invalid_argument', `unknown tool: ${tool}`, false);
    }
  } catch (error) {
    return convertToolBridgeAdminError(error);
  }
}
