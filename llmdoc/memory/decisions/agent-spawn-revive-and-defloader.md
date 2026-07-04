# 决策：re-Spawn 复活 terminated 实例 + Authorizer 接 AgentDefLoader

- 日期：2026-07-04（Round 33，线上实测逼出的两个架构修正）
- 状态：已定案（Proto §3.2 已补充复活语义）

## 决定 1：re-Spawn 复活 terminated 实例

- 对已 terminated 的实例再次 Spawn（同 instanceKey）→ **复活**：重置运行态 + **按当前 AgentDefinition 重新快照**（harness/model/toolScopes/systemPrompt 全部取最新 def）。
- **Send 不复活**：Send 到 terminated/未 Spawn 实例仍是 not_found（R27 幽灵 DO 防护语义不变，pitfalls §47）。
- Proto §3.2 已回写该语义（宪法先行）。

### 理由

- terminated 实例占着 instanceKey，原语义下该 key 永久报废——重建同名实例只能换 key，违反"同名恒路由同一实例"的直觉。
- **顺带解决实例快照永不追随 def 更新的问题**：实例 state 在首次 Spawn 时快照 def，此后 def Update 对既有实例无效；re-Spawn 重新快照给了一条显式的"刷新到最新 def"路径。
- 复活入口限定 Spawn（显式管理动作），Send（数据面投递）不触发——防止拼错 id 的投递静默复活/新建实例。

## 决定 2：Authorizer 接 AgentDefLoader

- 平台 `newAuthorizer` 增 **AgentDefLoader**：core authorize 步骤 2 需要 `claims.agent_def` 对应的 def 时**惰性加载播种**（原实现恒传空 agentDefs 索引）。

### 理由

- 历史空索引导致**一切 agent 主体在步骤 2 被误拒**（"agent definition not found"）——lurker 出站、htbp 工具 Check 等全部 PEP 面对 agent 主体系统性失效；此前只能各调用点手工播种（pitfalls §51/§53 同类坑）。
- AgentDefLoader 在判定点统一收口"判定点必须能解析 claims 引用的数据面"，替代逐点绕道；lurker 出站原有的播种绕道保留（行为等价）。

## 影响

- R33 实证：lurker 主体全链过 PEP（audit `tool://test/echo/get-uuid` read+invoke allow）。
- 相关坑：toolchain-pitfalls §47（幽灵 DO）、§51/§53（空索引误拒同根）。
