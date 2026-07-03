// Tool Layer 纯逻辑（Proto §5.2 ToolRegistry / §5.1 ToolProvider）——无 Cloudflare 绑定。

// 类型层（§5.2 ToolMount + 虚拟化）
export {
  type ToolMount,
  type ToolVirtualize,
  toolMountSchema,
  toolVirtualizeSchema,
} from './types.ts';
