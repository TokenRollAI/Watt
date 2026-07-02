# 决策：错误响应 body = 裸 WattError（无信封）

- 日期：2026-07-02（Round 3，Phase 0 关门质量关口）
- 状态：已实施并回写 Proto（`pnpm verify` 绿 + 线上 curl 验证）

## 决策

1. **HTTP 错误响应 body 就是裸 `WattError` 对象**（`{code,message,retryable}`），依据 Proto §11.3。**决不使用 `{error:...}` 信封**或任何其他包裹结构。
2. **7 码不扩容**。规范外场景复用现有码，已回写为 Proto §0.2 规范性补充：
   - 未认证 **401 → `permission_denied`**；
   - 未实现 **501 → `unavailable`**。

## 来源

- Phase 0 质量关口 contract 维度 finding：gateway 占位实现曾用 `{error: WattError}` 信封 + 规范外码 `unimplemented`，与 Proto §11.3 / §0.2 冲突。
- 处置：实现改裸体 + `unavailable`；Proto §0.2 回写两条规范性补充（宪法优先，先修 Docs 再对齐实现）。
- 关联：`llmdoc/memory/doc-gaps.md` #17（已闭环）；契约细节见 `llmdoc/reference/proto-map.md` 横切契约四。

## 对后续实现的约束

- 所有模块（gateway、HTBP 树、platform 端点）的错误路径统一返回裸 WattError；测试断言 body 顶层就是 `code` 字段。
- 新增错误场景先查 7 码能否覆盖，不得私加扩展码。
