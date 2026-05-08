# 客户端配合事项

> 服务端重构（见 [refactor-plan.md](./refactor-plan.md)）中需要客户端发版同步的改动。
> 每条事项的处理顺序：**客户端先发版 → 服务端再合 PR**，避免线上 4xx / 字段缺失。

---

## CR-01 移除 FCM 推送注册（对应服务端 T-02）

- **服务端动作**：删除 `POST /api/register-push-token` 接口、`push_token` 表、整个 FCM 链路。
- **客户端需要做**：
  1. 移除调用 `POST /api/register-push-token` 的代码路径（启动注册 / token 刷新都不再调）。
  2. 移除 FCM SDK 集成（如果离线消息已完全走 WS + `local_outbox_messages`，FCM 已无作用）。
  3. 确认 push 通知统一走 WS `proactive` op + `queued_batch` 重连兜底。
- **影响**：
  - 调用 `POST /api/register-push-token` 服务端会返回 404；客户端如未删除会反复打错 → 监控告警。
- **状态**：⏳ 待客户端发版

---

## CR-02 不再读 `familiarity` 字段（对应服务端 T-03）

- **服务端动作**：删除 `character_state.familiarity` 列、`/api/character/bootstrap` 与 `/api/relationship/state` 的 payload 不再带 `familiarity`。
- **客户端需要做**：
  1. UI 展示亲密度档位**只读 `relationship.level`**（-2 ~ 9 整数，12 档），不要再读 `familiarity` / `relationshipState.familiarity`。
  2. 如有"亲密度进度条"/"档位描述"基于 `familiarity / 100` 的公式，迁移到 `relationship.intimacyScore` (0-200) 或直接用 `level`。
  3. 移除请求体里任何手动传 `familiarityHint` 的地方（如有）。
- **影响**：
  - 客户端如继续读 `familiarity` 会拿到 `undefined`，UI 可能显示错误档位。
- **状态**：⏳ 待客户端发版

---

## CR-03 主动消息记录形态变更（对应服务端 T-08，可能需要客户端配合）

- **服务端动作**：`assistant_turn` 不再写入 `memory_items` 表，仅保留在 `conversation_turns`。
- **客户端可能受影响处**（请客户端自检）：
  1. 任何走 `/api/memory/*` 检索接口期望返回 AI 回复内容的地方。
  2. `/api/character/bootstrap` 的 `coreMemories[]` 是否曾经包含 assistant_turn 类的 pinned 记录。
  3. 客户端如自己实现"AI 上次说了啥"的展示，应改为读 `conversation_turns` / WS history。
- **决策**：
  - 服务端改动前先跑 retrieval 回归（T-13），如果客户端实际没在 memory_items 里读 assistant_turn，可以**无须客户端改动**直接合并。
- **状态**：⏳ 待 T-13 跑完后判定

---

## CR-X 模板（新增条目时复用）

```markdown
## CR-XX 标题（对应服务端 T-XX）

- **服务端动作**：
- **客户端需要做**：
- **影响**：
- **状态**：⏳ 待客户端发版 / ✅ 客户端已发版
```

---

## 流程

1. 服务端 PR 写好后**先不 merge**，把对应 CR 条目状态改为「⏳ 等客户端」并在客户端 issue 里 @ 对应同学
2. 客户端发版（或确认无需改动）后，状态改为「✅ 已对齐」
3. 服务端 PR merge + 部署
