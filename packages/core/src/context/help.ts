import { type WattError, wattError } from '@watt/shared';

/**
 * Context 子树 Help DSL 生成器 + 最小 parser（HTBP `~help`，Reference §2.1）——纯逻辑，无 I/O。
 *
 * Help DSL 是 text/plain 的紧凑命令描述，行格式：`cmd <name> <METHOD> <path-template>`，
 * 附属性行 `q`/`h`/`body`/`returns`/`scope`/`effect`/`confirm`。方法名即 cmd 名（Proto §11.3a）。
 * 收口 doc-gap #21 的 parser 部分：Context 子树最小 ~help + 对拍 parser。
 */

export interface ContextCapabilities {
  search?: boolean;
  delete?: boolean;
}

export interface HelpCmd {
  name: string;
  method: string;
  path: string;
}

// 四动词恒有；scope 决定权限动作（read → context:// read；write → context:// write）。
const CORE_VERBS: { name: string; scope: 'read' | 'write' }[] = [
  { name: 'List', scope: 'read' },
  { name: 'Get', scope: 'read' },
  { name: 'Write', scope: 'write' },
  { name: 'Update', scope: 'write' },
];

/**
 * 生成 Context 子树某 namespace 的 ~help（text/plain）。
 * - 四动词各一条 `cmd <Name> POST /htbp/context/<ns>`，附 `scope` 属性行。
 * - capabilities.search → 追加 Search 行（scope read）；capabilities.delete → 追加 Delete 行（scope write）。
 * - 每条 cmd 行后跟一条 `  scope <read|write>` 属性行（缩进两格，parser 跳过属性行）。
 */
export function generateContextHelp(namespace: string, capabilities: ContextCapabilities): string {
  const path = `/htbp/context/${namespace}`;
  const verbs = [...CORE_VERBS];
  if (capabilities.search) verbs.push({ name: 'Search', scope: 'read' });
  if (capabilities.delete) verbs.push({ name: 'Delete', scope: 'write' });

  const lines: string[] = [];
  for (const verb of verbs) {
    lines.push(`cmd ${verb.name} POST ${path}`);
    lines.push(`  scope ${verb.scope}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 最小 Help DSL parser：逐行解析 `cmd` 行为 {name, method, path}。
 * - 非 cmd 行（属性行、空行、纯空白行）跳过。
 * - cmd 行须四段齐全非空：`cmd` 关键字 + name + METHOD + path；缺段 → invalid_argument。
 * - 返回 { cmds } 或第一处非法 cmd 行的 WattError。
 */
export function parseHelpDsl(text: string): { cmds: HelpCmd[] } | WattError {
  const cmds: HelpCmd[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    // 属性行（前导空白）与空行跳过；只解析顶格 cmd 行。
    if (line.trim() === '') continue;
    if (line[0] === ' ' || line[0] === '\t') continue;
    const parts = line.split(/\s+/).filter((p) => p !== '');
    if (parts[0] !== 'cmd') continue;
    if (parts.length < 4) {
      return wattError('invalid_argument', `malformed cmd line: ${line}`, false);
    }
    // 长度已保证四段齐全（parts[1..3] 非 undefined）。
    cmds.push({ name: parts[1] as string, method: parts[2] as string, path: parts[3] as string });
  }
  return { cmds };
}
