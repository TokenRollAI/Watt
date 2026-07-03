// Context Layer 纯逻辑（Proto §4.1 ContextProvider / §4.2 ContextRegistry）——无 Cloudflare 绑定。

// Help DSL 生成器 + parser（HTBP ~help，Reference §2.1；doc-gap #21 parser 部分）
export {
  type ContextCapabilities,
  generateContextHelp,
  type HelpCmd,
  parseHelpDsl,
} from './help.ts';

// URI 解析 + 挂载选路（§4.2 Resolve / §0.1）
export {
  type ParsedContextUri,
  parseContextUri,
  type ResolvedMount,
  resolveMount,
} from './resolve.ts';

// TTL 过期判定（§4.2 ttl）
export { isExpired } from './ttl.ts';
// 类型层（§4.1 / §4.2）
export {
  type ContextEntry,
  type ContextEntryInput,
  type ContextEntryMeta,
  type ContextPatch,
  contextEntryInputSchema,
  contextEntryMetaSchema,
  contextEntrySchema,
  contextPatchSchema,
  type NamespaceMount,
  namespaceMountSchema,
} from './types.ts';
// 四动词语义校验（§4.1）
export { applyPatch, checkIfVersion, requireExisting } from './verbs.ts';
