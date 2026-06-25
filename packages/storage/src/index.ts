/**
 * @watt/storage：平台无关的窄存储接口 + 内存实现。
 *
 * 五个窄接口按存储语义切分（docs/architecture.md「存储设计」、
 * docs/flue-reference.md「平台适配靠窄接口」）：
 * - RunStore：Run 状态 + 运行事件日志 + PlanScript journal（Run 维度权威）。
 * - RegistryStore：Agent / AgentVersion / Task 注册表。
 * - ArtifactStore：运行产物内容与元数据。
 * - MemoryStore：长期可复用知识。
 * - SessionStore：Session 记录与消息历史（接口签名层排除 RunId，会话不是 Run）。
 *
 * 内存实现供全部包测试使用；Cloudflare adapter（D1/DO/R2）属后续里程碑。
 */
export * from './errors.js';

export * from './run-store.js';
export * from './registry-store.js';
export * from './artifact-store.js';
export * from './memory-store.js';
export * from './session-store.js';

export { InMemoryRunStore } from './memory/in-memory-run-store.js';
export { InMemoryRegistryStore } from './memory/in-memory-registry-store.js';
export { InMemoryArtifactStore } from './memory/in-memory-artifact-store.js';
export { InMemoryMemoryStore } from './memory/in-memory-memory-store.js';
export { InMemorySessionStore } from './memory/in-memory-session-store.js';
