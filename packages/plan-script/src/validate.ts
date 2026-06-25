/**
 * PlanScript 静态校验：执行模型的第一道确定性防线。
 *
 * 用 acorn 把源码解析成 AST，做语法白名单与全局名引用校验。目的是在脚本进入
 * 沙箱之前就拒绝一切动态代码路径（import/export/eval/with/new Function）与对
 * 非确定性能力（Date.now / Math.random / fetch / setTimeout 等）的引用。
 *
 * 设计立场：静态校验是「编译期」防线，沙箱屏蔽（sandbox.ts）是「运行期」防线，
 * 两道都必须存在。任一被绕过，另一道仍能兜底（见 core-invariants.md 不变量 4）。
 *
 * 校验失败不抛裸异常，而是返回结构化错误列表（含源码位置），便于上层把错误投影
 * 成 PlanVersion 校验失败事件。
 */
import { parse } from 'acorn';
import * as walk from 'acorn-walk';
import type { Node } from 'acorn';
import { WRAPPER_PREFIX, wrapSource } from './entry.js';

/** Host API 8 函数：脚本内唯一允许引用的「外部能力」全局名。 */
export const HOST_GLOBAL_NAMES = [
  'run',
  'invoke',
  'spawn',
  'checkpoint',
  'approval',
  'sleep',
  'waitFor',
  'artifact',
] as const;

/**
 * 安全内建白名单：确定性、无副作用、无环境感知的语言子集。
 *
 * 刻意排除：Date（原生时间）、setTimeout/setInterval（原生定时器）、fetch/
 * XMLHttpRequest（网络）、WebAssembly/eval/Function（动态代码）、globalThis/
 * window/global（逃逸宿主全局）。Math 整体放行但 Math.random 在沙箱侧被删除
 * （静态层无法仅凭名字区分 Math.max 与 Math.random，故 random 的封堵交给沙箱）。
 */
export const SAFE_GLOBAL_NAMES = [
  // 字面量全局
  'undefined',
  'NaN',
  'Infinity',
  // 确定性命名空间与构造器
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Symbol',
  'Math',
  'JSON',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  // 确定性全局函数
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'structuredClone',
  // 控制台（沙箱侧会提供无害实现，便于脚本调试；不影响确定性）
  'console',
] as const;

/** 校验错误的结构化表示。loc 为 1-based 行列，便于上层定位。 */
export interface ValidationError {
  /** 机器可读分类码 */
  code:
    | 'forbidden_syntax'
    | 'unknown_global'
    | 'forbidden_global'
    | 'parse_error';
  /** 人类可读说明 */
  message: string;
  /** 源码字符偏移（0-based），解析失败时可能缺省 */
  start?: number;
  end?: number;
  /** 1-based 行列 */
  line?: number;
  column?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/** 被静态白名单永久禁止、即使作为内建名也不放行的全局名。 */
const FORBIDDEN_GLOBALS = new Set([
  'eval',
  'Function',
  'Date',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'clearTimeout',
  'clearInterval',
  'globalThis',
  'window',
  'self',
  'global',
  'process',
  'require',
  'module',
  'exports',
  'import',
  'WebAssembly',
  'Reflect',
  'Proxy',
  'Atomics',
  'SharedArrayBuffer',
  'performance',
  'crypto',
  'navigator',
  'document',
]);

const ALLOWED_GLOBALS = new Set<string>([
  ...HOST_GLOBAL_NAMES,
  ...SAFE_GLOBAL_NAMES,
  // host 聚合对象：protocol-v1.md 规定沙箱内可见的全局对象，等价于 8 函数命名空间。
  'host',
]);

/**
 * acorn 节点 type 黑名单：动态代码路径与非确定性结构，命中即拒。
 *
 * - ImportDeclaration / ExportNamed.../ ImportExpression：模块系统，沙箱无模块图。
 * - WithStatement：with 破坏静态作用域分析，禁止。
 * - new Function / Function 表达式中的动态构造由 NewExpression + callee 名校验覆盖，
 *   eval 调用由全局名引用校验覆盖（eval 不在白名单）。
 */
const FORBIDDEN_NODE_TYPES: Record<string, string> = {
  ImportDeclaration: 'import 声明被禁止（沙箱无模块系统）',
  ImportExpression: '动态 import() 被禁止',
  ExportNamedDeclaration: 'export 声明被禁止',
  ExportDefaultDeclaration: 'export default 被禁止',
  ExportAllDeclaration: 'export * 被禁止',
  WithStatement: 'with 语句被禁止（破坏静态作用域分析）',
};

/**
 * 构造一个校验错误。node 的位置基于「包裹后源码」，这里映射回原始源码：
 * 先把字符偏移减去 WRAPPER_PREFIX 长度得到原始偏移，再直接在原始源码上推导 1-based
 * 行列。这样不依赖前缀占几行的假设，最稳。
 */
function toError(
  code: ValidationError['code'],
  message: string,
  node?: Node,
  originalSource?: string,
): ValidationError {
  const err: ValidationError = { code, message };
  if (node) {
    const prefixLen = WRAPPER_PREFIX.length;
    const start = node.start - prefixLen;
    err.start = start;
    err.end = node.end - prefixLen;
    if (originalSource !== undefined && start >= 0) {
      const before = originalSource.slice(0, start);
      const lastNl = before.lastIndexOf('\n');
      err.line = before.split('\n').length; // 1-based 行
      err.column = start - lastNl; // 1-based 列（lastNl=-1 时即 start+1）
    }
  }
  return err;
}

/**
 * 校验单段 PlanScript 源码。
 *
 * 流程：
 * 1. acorn parse（ecmaVersion 2022、sourceType module 以允许顶层 await）；语法错误即返回。
 * 2. 遍历 AST，命中禁止节点类型即记错。
 * 3. 收集所有被「引用」的标识符（Identifier 读取位置），扣除局部绑定（声明的变量/参数/
 *    函数名/import 名等），剩余即自由全局引用；不在白名单或命中禁止名即记错。
 *
 * 注意：第 3 步用 acorn-walk 的 ancestor 模式判断标识符是否处于「引用」位置（排除
 * 属性名、对象键、声明名等非引用出现），并用一个保守的作用域收集近似局部绑定集合。
 */
export function validatePlanScript(source: string): ValidationResult {
  const errors: ValidationError[] = [];

  // 校验「包裹后」的源码，与执行入口形态一致（见 entry.ts）：脚本是一段 async 函数体，
  // 顶层 await / return / Host 调用都合法。位置在 toError 中映射回原始源码。
  const wrapped = wrapSource(source);

  let ast: Node;
  try {
    ast = parse(wrapped, {
      ecmaVersion: 2022,
      // script 形态即可（await/return 由 async IIFE 包裹合法化）；import/export 仍由
      // 禁止节点类型拦截。
      sourceType: 'module',
    }) as unknown as Node;
  } catch (e) {
    const err = e as { message?: string; pos?: number; loc?: { line: number; column: number } };
    const prefixLen = WRAPPER_PREFIX.length;
    errors.push({
      code: 'parse_error',
      message: `语法解析失败：${err.message ?? String(e)}`,
      start: err.pos !== undefined ? err.pos - prefixLen : undefined,
      line: err.loc !== undefined ? err.loc.line - 1 : undefined,
      column: err.loc !== undefined ? err.loc.column + 1 : undefined,
    });
    return { ok: false, errors };
  }

  // —— 第 2 步：禁止节点类型 ——
  walk.full(ast, (node) => {
    const reason = FORBIDDEN_NODE_TYPES[node.type];
    if (reason) {
      errors.push(toError('forbidden_syntax', reason, node, source));
    }
  });

  // —— 第 3 步：全局名引用校验 ——
  // 先收集所有局部绑定名（声明的标识符）。这是保守近似：只要某个名字在脚本任意
  // 位置被声明为局部绑定，就不把它当作自由全局引用（可能放过个别遮蔽场景，但对
  // 「拒绝未知全局」这一目标是安全方向——不会误判合法局部为非法全局）。
  const localNames = collectLocalBindings(ast);

  // 收集自由引用（读取位置的 Identifier，排除属性名/对象键/声明名）。
  const referencedGlobals = collectFreeReferences(ast, localNames);

  for (const ref of referencedGlobals) {
    const name = (ref.node as unknown as { name: string }).name;
    if (FORBIDDEN_GLOBALS.has(name)) {
      errors.push(
        toError('forbidden_global', `禁止引用全局名 "${name}"`, ref.node, source),
      );
    } else if (!ALLOWED_GLOBALS.has(name)) {
      errors.push(
        toError(
          'unknown_global',
          `引用了未声明的全局名 "${name}"（仅允许 Host API 与安全内建）`,
          ref.node,
          source,
        ),
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 收集脚本内所有被声明为局部绑定的标识符名。 */
function collectLocalBindings(ast: Node): Set<string> {
  const names = new Set<string>();

  const addPattern = (pattern: Node | null | undefined): void => {
    if (!pattern) return;
    const n = pattern as unknown as {
      type: string;
      name?: string;
      properties?: unknown[];
      elements?: unknown[];
      argument?: Node;
      left?: Node;
      value?: Node;
      key?: Node;
      computed?: boolean;
    };
    switch (n.type) {
      case 'Identifier':
        if (n.name) names.add(n.name);
        break;
      case 'ObjectPattern':
        for (const prop of n.properties ?? []) {
          const p = prop as { type: string; value?: Node; argument?: Node };
          if (p.type === 'RestElement') addPattern(p.argument);
          else addPattern(p.value);
        }
        break;
      case 'ArrayPattern':
        for (const el of n.elements ?? []) addPattern(el as Node | null);
        break;
      case 'RestElement':
        addPattern(n.argument);
        break;
      case 'AssignmentPattern':
        addPattern(n.left);
        break;
    }
  };

  walk.full(ast, (node) => {
    const n = node as unknown as {
      type: string;
      id?: Node | null;
      params?: Node[];
      local?: Node;
      imported?: Node;
    };
    switch (node.type) {
      case 'VariableDeclarator':
        addPattern((node as unknown as { id: Node }).id);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (n.id) addPattern(n.id);
        for (const p of n.params ?? []) addPattern(p);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (n.id) addPattern(n.id);
        break;
      case 'CatchClause':
        addPattern((node as unknown as { param?: Node | null }).param);
        break;
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        // import 本身已被禁止，但仍登记其本地名，避免重复报「未知全局」噪声。
        if (n.local) addPattern(n.local);
        break;
    }
  });

  return names;
}

interface FreeRef {
  node: Node;
}

/**
 * 收集自由标识符引用（处于「读取/调用」位置、且不在局部绑定集合中的 Identifier）。
 *
 * 用 acorn-walk 的 ancestor 模式拿到父节点，借此排除非引用出现：
 * - 成员访问的属性名（a.b 中的 b，非 computed）
 * - 对象字面量的键（{ k: v } 中的 k，非 computed）
 * - 各类声明位置的名字（已被 collectLocalBindings 覆盖，这里再排除以免重复判定）
 */
function collectFreeReferences(ast: Node, localNames: Set<string>): FreeRef[] {
  const refs: FreeRef[] = [];

  walk.ancestor(ast, {
    Identifier(node, _state, ancestors) {
      const name = (node as unknown as { name: string }).name;
      // ancestors 末尾是 node 自身，倒数第二是直接父节点。
      const parent = ancestors[ancestors.length - 2] as unknown as
        | {
            type: string;
            property?: Node;
            object?: Node;
            key?: Node;
            value?: Node;
            computed?: boolean;
            id?: Node;
            label?: Node;
            local?: Node;
            imported?: Node;
            exported?: Node;
            params?: Node[];
          }
        | undefined;

      if (!parent) return;

      // 排除成员访问属性名：obj.prop 中的 prop（computed 时 prop 是真实引用，保留）。
      if (parent.type === 'MemberExpression' && parent.property === (node as unknown) && !parent.computed) {
        return;
      }
      // 排除对象字面量/类的键名（非 computed）。
      if (
        (parent.type === 'Property' || parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') &&
        parent.key === (node as unknown) &&
        !parent.computed
      ) {
        return;
      }
      // 排除各类声明位置名（这些是绑定，不是引用）。
      if (
        (parent.type === 'VariableDeclarator' && parent.id === (node as unknown)) ||
        ((parent.type === 'FunctionDeclaration' ||
          parent.type === 'FunctionExpression' ||
          parent.type === 'ArrowFunctionExpression' ||
          parent.type === 'ClassDeclaration' ||
          parent.type === 'ClassExpression') &&
          parent.id === (node as unknown)) ||
        (parent.type === 'ImportSpecifier' && (parent.local === (node as unknown) || parent.imported === (node as unknown))) ||
        ((parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') &&
          parent.local === (node as unknown)) ||
        (parent.type === 'ExportSpecifier') ||
        (parent.type === 'LabeledStatement' && parent.label === (node as unknown)) ||
        (parent.type === 'BreakStatement' || parent.type === 'ContinueStatement')
      ) {
        return;
      }
      // 函数参数本身是绑定，不是引用。
      if (
        (parent.type === 'FunctionDeclaration' ||
          parent.type === 'FunctionExpression' ||
          parent.type === 'ArrowFunctionExpression') &&
        (parent.params ?? []).includes(node as unknown as Node)
      ) {
        return;
      }

      // 已是局部绑定的名字不算自由全局引用。
      if (localNames.has(name)) return;

      refs.push({ node });
    },
  });

  return refs;
}
