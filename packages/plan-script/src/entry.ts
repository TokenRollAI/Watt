/**
 * PlanScript 脚本入口形态（本实现的设计决策，单一事实来源）。
 *
 * 决策：PlanScript 源码是一段「async 函数体」——可在顶层使用 await、return、以及
 * 直接调用 Host 全局函数。执行与校验都把它包进同一个 async IIFE：
 *
 *   (async () => {
 *   <用户源码>
 *   })()
 *
 * 理由：
 * - 允许顶层 await host.run(...)（最自然的编排写法），同时 return 表达整段计划的完成值。
 * - 校验与执行共用同一包裹，保证「能解析」与「能执行」对脚本形态的判断完全一致。
 * - 包裹不引入任何新的自由全局名，故全局名引用校验不受影响。
 *
 * WRAPPER_PREFIX 的字符长度用于把校验报错位置从包裹源映射回原始源码（减去前缀）。
 */
export const WRAPPER_PREFIX = '(async () => {\n';
export const WRAPPER_SUFFIX = '\n})()';

/** 把用户源码包进 async IIFE。校验与执行必须共用本函数，保证入口形态一致。 */
export function wrapSource(source: string): string {
  return `${WRAPPER_PREFIX}${source}${WRAPPER_SUFFIX}`;
}
