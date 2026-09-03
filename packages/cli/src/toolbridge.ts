import { type HttpDeps, htbpCall } from './client.ts';
import { CliError } from './env.ts';

export async function toolBridgeAdminCall(
  base: string,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  deps: HttpDeps = {},
): Promise<unknown> {
  return htbpCall(base, token, 'toolbridge', tool, args, deps);
}

export function parseToolBridgeArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new CliError('--args must be a JSON object', 2);
  }
}
