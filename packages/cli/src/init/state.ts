/**
 * init 向导：部署应答存档 + 断点续跑状态（P5，计划 §P5）。
 *
 * 存档 `~/.watt/deployments/<prefix>/answers.json`（**永不含 secret**：token/私钥/加密 key 不进此文件；
 *   admin token 单独写 ~/.watt/credentials.json 0600）。`watt init --resume` 读它续跑，
 *   completed 标记为 true 的步骤跳过（每步幂等可重入）。
 */

import type { D1Ids, KvIds } from './wrangler-config.ts';

/** init 的有序步骤（pendingSteps 按此序过滤已完成项）。 */
export const STEP_ORDER = [
  'auth', // wrangler whoami 检查
  'provision', // 存储资源幂等创建
  'config', // 渲染三份 wrangler.jsonc 到部署目录
  'migrations', // 五库 migrations apply --remote
  'secrets', // 信任根三 secret + 首 admin token
  'deploy', // toolbridge → plugin-feishu(启用时) → gateway → dashboard
  'llmSecret', // 可选 LLM key 经 SecretStore 写入
] as const;
export type InitStep = (typeof STEP_ORDER)[number];

export interface DeploymentState {
  version: 1;
  namePrefix: string;
  customDomain?: string;
  adminPrincipal: string;
  feishuEnabled: boolean;
  /** 是否在问答阶段提供了 LLM key（真值不存档，仅记布尔驱动 llmSecret 步骤）。 */
  llmKeyProvided: boolean;
  /** LLM key 经 SecretStore 写入时的 secret 名（默认 WATT_LLM_KEY）。 */
  llmSecretName?: string;
  createdAt: string;
  completed: Partial<Record<InitStep, boolean>>;
  /** provision 产出（config 步骤渲染模板回填占位符用）。 */
  d1Ids?: D1Ids;
  kvIds?: KvIds;
  /** 收尾输出用。 */
  gatewayUrl?: string;
  dashboardUrl?: string;
}

/** 给定状态，返回仍需执行的步骤（completed=true 的跳过）——`--resume` 的核心。 */
export function pendingSteps(state: DeploymentState): InitStep[] {
  return STEP_ORDER.filter((s) => state.completed[s] !== true);
}

/** 标记某步完成（返回新状态，不可变更新）。 */
export function markCompleted(state: DeploymentState, step: InitStep): DeploymentState {
  return { ...state, completed: { ...state.completed, [step]: true } };
}

/** 新建初始状态。 */
export function newState(input: {
  namePrefix: string;
  customDomain?: string;
  adminPrincipal: string;
  feishuEnabled: boolean;
  llmKeyProvided: boolean;
  llmSecretName?: string;
  now?: () => number;
}): DeploymentState {
  const now = input.now ?? Date.now;
  return {
    version: 1,
    namePrefix: input.namePrefix,
    customDomain: input.customDomain,
    adminPrincipal: input.adminPrincipal,
    feishuEnabled: input.feishuEnabled,
    llmKeyProvided: input.llmKeyProvided,
    llmSecretName: input.llmSecretName,
    createdAt: new Date(now()).toISOString(),
    completed: {},
  };
}
