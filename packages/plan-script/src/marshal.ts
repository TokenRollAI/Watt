/**
 * 宿主值 ↔ QuickJS handle 的编组（marshalling）工具。
 *
 * PlanScript 的 Host 参数与返回值都是纯 JSON 数据（@watt/protocol 的 *Params /
 * *Result schema 保证），因此用 JSON 作为跨沙箱边界的传输形态最省、最确定性：
 * - JS → handle：在宿主侧 JSON.stringify，再用沙箱内置 JSON.parse 重建。
 * - handle → JS：直接用 context.dump（best-effort 序列化）。
 *
 * 这样无需手写递归 handle 构造，也天然规避了函数/symbol 等不可序列化值越界。
 */
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

/**
 * 把宿主侧 JSON 值注入沙箱，返回一个新的 QuickJSHandle（调用方负责 dispose）。
 * undefined 直接映射为沙箱 undefined（JSON 无法表达 undefined）。
 */
export function jsonToHandle(context: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === undefined) return context.undefined;
  const json = JSON.stringify(value);
  // 用沙箱内 JSON.parse(jsonStr) 在沙箱地址空间内重建对象。
  using jsonNs = context.getProp(context.global, 'JSON');
  using strHandle = context.newString(json);
  const parsed = context.callMethod(jsonNs, 'parse', [strHandle]);
  return context.unwrapResult(parsed);
}

/**
 * 从沙箱读出一个 handle 的 JS 值（深拷贝到宿主地址空间）。
 * 用于读取脚本传给 Host 函数的实参。
 */
export function handleToJson(context: QuickJSContext, handle: QuickJSHandle): unknown {
  return context.dump(handle);
}
