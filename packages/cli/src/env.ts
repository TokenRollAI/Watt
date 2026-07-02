/**
 * Watt CLI 运行环境读取（Proto/DOD §2 Phase 0）。
 * 从环境变量读取 WATT_BASE_URL / WATT_TOKEN。
 */

export interface WattEnv {
  baseUrl?: string;
  token?: string;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): WattEnv {
  return {
    baseUrl: env.WATT_BASE_URL?.trim() || undefined,
    token: env.WATT_TOKEN?.trim() || undefined,
  };
}

/** CLI 内部错误：携带建议的进程退出码。 */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
