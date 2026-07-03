# 决策：ScriptRunner 可注入抽象 + watt binding 经 RPC 参数注入

> 2026-07-03（Round 21，Phase 5 Scheduler/M6 script action）。

## 决定

cron script action（Proto §7：一次性隔离 isolate 执行）的执行器抽象为可注入接口 `ScriptRunner`：

- **生产 = LoaderScriptRunner**：Dynamic Worker Loader（`env.LOADER.load`）起真 isolate，`globalOutbound: null` 禁网，凭证不进脚本运行时。
- **测试 = fake runner 注入**：本地 vitest-pool-workers **无 LOADER 绑定**（线上 open beta，DJJ 账户已开通实证）——fake 走**同一 watt binding + 同一 Authorizer.Check 路径**，能力表与鉴权语义在本地即可验证，只有"真 isolate 起得来"留部署冒烟。

## watt binding 注入方式（两次线上失败迭代出的硬约束）

loader 的 `env` 字段走 **structured clone**：plain object 闭包函数、RpcTarget 实例都被拒（"could not be cloned" 线上实测两次）。Cap'n Web 只在 **RPC 边界**把 RpcTarget 转 stub——故 watt binding（`WattBindingRpc extends RpcTarget`）经 **entrypoint RPC 调用参数**传入，脚本入口约定：

```js
export default class extends WorkerEntrypoint {
  async run(watt) { return watt.publish({ type: '...', payload: {...} }); }
}
```

详见 toolchain-pitfalls §44 与 `script-runner.ts` 文件头。

## 能力表与鉴权

- **最小面 = `watt.publish` 一个能力**（满足 DoD"查桩指标→Publish 出站事件"；未来扩 metrics.read 等按同一 Check 门控接线）。
- 每次 publish 过 `platform://event` 'manage' 的 Check（与平台 event Publish 同权面）。
- claims 构造：principal=job.createdBy + IdentityMapper **实时 roles** + chain=`[cron:<jobId>]`；authorize 的 `cronJobs` 索引**直接以本 job 播种**（本 job 就是链上唯一 cron 段，上限=job.action.grants，无需外查 Scheduler.Get，自足）。

## 代价与边界

- fake runner 验不了 isolate 边界本身（禁网、structured clone 语义）——真 isolate 行为只有部署冒烟覆盖，本地绿不等于 loader 路径通。
- 脚本内容承载当前只支持 structured provider（`context://automations/<id>`）；Scheduler Write 不做 grants≤createdBy 静态校验（§7 推迟运行时，见 doc-gaps #29⑧）。

真源：`packages/gateway/src/scheduler/script-runner.ts`（文件头注释 = 完整设计声明）；doc-gaps #29⑥⑦。

相关：[[task-workflow-instance-id]]（同 Phase 的 Task 侧决策）。
