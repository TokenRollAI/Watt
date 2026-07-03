// Agents SDK 需要全局 `Env`（= Cloudflare.Env）作 Agent<Env,State> 泛型 + getAgentByName<Env>。
// Watt 用 src/env.ts 的 Bindings 作运行时绑定真源；此处声明合并 Cloudflare.Env extends Bindings，
// 使 src 编译期 `Env` 全局解析到 Bindings（cf-typegen 的等价物，手写以不引入生成步骤）。
// test/env.d.ts 在此基础上再合并 TEST_* 测试绑定（声明合并，互不冲突）。

import type { Bindings } from './env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
