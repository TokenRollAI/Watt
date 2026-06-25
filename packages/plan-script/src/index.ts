/**
 * @watt/plan-script 公共 API。
 *
 * 三块能力：
 * 1. 静态校验：validatePlanScript（语法白名单 + 全局名引用校验）。
 * 2. 重放执行：replayPlanScript（QuickJS 沙箱 + journal 重放 + gas/超时/预算截停）。
 * 3. 类型与常量：ReplayResult / PendingCall / Host 全局名 / 安全内建白名单等。
 *
 * 见 architecture/execution-model.md「Script Runner」与 core-invariants.md 不变量 4。
 */
export {
  validatePlanScript,
  HOST_GLOBAL_NAMES,
  SAFE_GLOBAL_NAMES,
  type ValidationError,
  type ValidationResult,
} from './validate.js';

export { replayPlanScript, executeInSandbox, setQuickJSVariant } from './sandbox.js';

export {
  normalizeHostParams,
  paramsEqual,
  type NormalizedParamsOk,
  type NormalizedParamsErr,
} from './host-bridge.js';

export type {
  PendingCall,
  ReplayDiagnostic,
  ReplayResult,
  ReplayOptions,
} from './types.js';
