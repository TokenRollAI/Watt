import { defineConfig } from 'tsup';

/**
 * CLI 发行 bundle（P4，计划 §P4）：src/bin.ts → dist/bin.js。
 *
 * - ESM / target node20：与 package.json engines(node>=20) 对齐；bin.ts 用顶层 await（node20+ ESM 支持）。
 * - noExternal（inline）：@watt/core、@watt/shared、@watt/plugin-feishu 是 private TS 源包，
 *   registry 上不存在——必须打进 bundle（原则：workspace 包 inline）。plugin-feishu 经其 main 入口
 *   (`./src/adapter/index.ts` 纯逻辑 barrel) 引入，Worker 宿主（./worker 子路径）不在图内，
 *   故 cloudflare 运行时/类型不会被带进 CLI。
 * - external（进 dependencies，registry 包）：commander / zod / jose 是公开 registry 包，安装期可解析。
 * - external（进 optionalDependencies）：@larksuiteoapi/node-sdk 仅 `channel connect` 本地 WS dev 路径
 *   动态 import；缺失时 connect.ts try/catch 给安装指引（生产走 plugin Worker webhook，不需此包）。
 * - shebang：bin.ts 源首行 `#!/usr/bin/env node` 由 esbuild 保留进 dist/bin.js 顶部，tsup 同时 chmod 755。
 */
export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  clean: true,
  treeshake: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  shims: false,
  noExternal: ['@watt/core', '@watt/shared', '@watt/plugin-feishu'],
  external: ['commander', 'zod', 'jose', '@larksuiteoapi/node-sdk'],
});
