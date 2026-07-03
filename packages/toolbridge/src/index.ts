/**
 * watt-toolbridge Worker 入口（Phase 4 M4 Tool Gateway 部署单元）。
 *
 * 这是 `TokenRollAI/tool-bridge`（分支 feat/watt-builtin-and-tool-semantics，commit 56ab13b）
 * 的 worker 源码 vendored 到 ../vendor/（见 ../README.md 说明与升级流程）。本文件只做薄再导出：
 * 整棵 HTBP 树的解析/~help/调用/虚拟化/租户逻辑全在 vendor/ 的上游实现里，Watt 侧不改上游一行
 * （唯一偏离是 vendor/index.ts + vendor/types.d.ts 里标注的 "WATT VENDOR PATCH"：headless 部署
 * 无 ASSETS 绑定时 404 兜底）。
 *
 * 集成拓扑（方案 A，见 .llmdoc-tmp/investigations/phase4-tool-agent.md §拓扑）：
 * watt-toolbridge 作为独立 Worker，Watt gateway 经 service binding TOOLBRIDGE 把 /htbp/tools/*
 * 代理到本 Worker 的 /htbp/*（Check PEP + 错误形状转换 + 可见性裁剪在 gateway 代理层，见
 * packages/gateway/src/http/tools-proxy.ts）。租户树由 gateway 在转发前写入共享 KV
 * （TENANT_MODE=true + TENANTS 绑定 watt-tenants），本 Worker 按 Secret Key 加载对应租户树。
 */

import worker from '../vendor/index';

export default worker;
