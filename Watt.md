# Watt

## Vision

### Agent Infra

### 派生 Agent

### 管理 Agent

### Context Layer

### Tool Layer

### 廉价的云上运行

- Cloudflare
  
- S3
  
- CF Container
  
### 易于拓展

## 能力

### Context Layer

- 多来源
  
    - FS
      
    - 飞书文档
      
    - mem0 ...
      
    - 其他自定义 Provider
      
### Tool Layer

- 为任何环境的 Agent 提供工具访问和 Context Layer 的访问能力
  
    - https://github.com/TokenRollAI/HTBP
      
    - https://github.com/TokenRollAI/tool-bridge
      
### Event Gateway

- 作用
  
    - 维持和 IM 的长期通信
      
    - Agent 和 Agent 之间的通信
      
- 来源
  
    - Agent
      
        - Manage Agent
          
    - IM
      
        - feishu
          
        - dingding
          
        - slack
          
    - webhook
      
        - 直接通过 API Cal
          
### Management

- Manage Agent
  
    - 在每个层级都都有一个 Agent 用来降低使用门槛
      
- Dashboard
  
    - User -> Agent
      
    - User -> Context
      
    - User -> Tool
      
    - User -> Cronjob
      
    - User -> Task
      
    - User -> Event
      
    - User -> IM
      
    - User -> Agent Workflow
      
### Runtime / Agent Framework

### Auth

- Agent 是否能够访问某个工具/context
  
## Case

### 自动交付需求

- 1. 通过 webhook 收到了一个用户反馈
  
- 2. 启动Agent
  
    - 获取历史上类似的反馈
      
    - 检查是否已经修复
      
    - 发现是一例新的 bug
      
    - 更新 Feedback/bugs context
      
    - 使用 Logs/Trace/Metrics 查看报错信息
      
    - 找到报错的原因
      
        - 同步到 slack / feishu
          
    - 通知给对应的 Coding Agent: 在对应的 repo / container 中开始修复
      
    - 修复后通知给QA Agent: 验证OK
      
    - 推送 PR
      
    - Review Agent 确认代码改动 OK
      
    - 走 CI/CD OK, 推送测试环境, 等待人类确认
      
    - 上线: 人类手动确认上线
      
- 3. 结论汇报
  
    - 1. 同步飞书
      
    - 2. 同步context layer
      
### deepresearch

- 1. 用户通过飞书发送了一个问题, 并表示需要深度调研
  
- 2. master agent 制定了一个详细的调研方案
  
- 3. 用户飞书确认可行
  
- 4. master agent 派生 N 个 subagent 使用 websearch 工具
  
- 5. subagent收集到足够多的信息
  
- 6. master agent 汇总, 返回消息
  
### 群聊记录

- 1. 用户将一个飞书机器人加入到飞书群内
  
- 2. 群里一直讨论某个话题
  
- 3. agent 始终不回复, 持续记录话题内容
  
    - 派生 subagent 获取相关的 context
      
        - 将相关的 context 存储到临时的 context layer 中
          
- 4. 用户突然 @subagent 确认是否存在问题
  
    - agent 根据 context 返回结果 回答用户
      
### 权限控制

- 1. 用户 A 和用户 B 和同一个 财务 Agent 聊天
  
- 2. A 是 CEO, 有权限获取信息
  
    - 财务 Agent 正常回答
      
- 3. B 是普通员工
  
    - 财务 Agent 无法使用工具, 被拒绝
      
### Provider 管理

- admin 账号登录到 dashboard
  
- 查看了现在正在运行的agent数量和 task 数量
  
- 查看了最近 7 天的 token 数量, 计费数量和 缓存命中率
  
- 发现某个渠道的缓存命中率很低
  
- 增加了一个新的模型来源, 并且将默认的模型来源指向他
  
### 定时任务

- admin 访问 dashboard
  
- 和 manage agent 发布了一个新的 cron job, 定时的获取每天的 token 用量并且通过 webhook 发送给飞书的某个群
  
- agent 写脚本, 发布定时任务
