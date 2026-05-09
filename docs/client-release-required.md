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

## CR-04 Character Cognition Layer v1（feature/character-system 分支落地）

> 服务端在 `feature/character-system` 分支完成了 7 层角色认知系统（Phase CC-1 ~ CC-4），
> 设计见 [character-cognition-architecture.md](./character-cognition-architecture.md)，
> 接入手册见 [character-system.md](./character-system.md)。
> 本条 CR 拆 4 节，前 3 节是**新增能力**（客户端可按需接），第 4 节是 **deprecated 窗口提醒**。

### CR-04.1 新增主入口端点 `POST /api/character/context`（推荐替代 bootstrap）

- **服务端动作**：新增聚合端点，一次返回 7 层完整 payload + 拼好的 `promptFragment`（≤1500 中文字）。
- **客户端建议做**（**非强制**，旧路径仍能用 1 个 release）：
  1. 替换 `GET /api/character/bootstrap` + `GET /api/relationship/state` 调用 → `POST /api/character/context`，body：
     ```json
     { "assistantId": "...", "includePromptFragment": true }
     ```
  2. 直接把响应里的 `promptFragment` 拼进 system prompt，不再自己拼 identity / state / dynamics 三段。
  3. 如果想要更精细的控制（比如只展示 mood / 不要 dynamics），用结构化字段：
     `identity / characterState / emotion / relationshipDynamics / socialMode / activeTopics / recentEpisodes / latestReflection`
- **影响**：
  - 旧客户端继续走 `/relationship/state` + `/character/bootstrap` 不会断（payload schema 不动）。
  - 新客户端用 `/character/context` 拿到的 system prompt 上下文更完整、token 更省（重复字段不再每次重发）。
- **状态**：⏳ 待客户端按需迁移

### CR-04.2 新增 admin / debug 端点（无需客户端集成，可选）

| 端点 | 用途 |
|------|------|
| `GET /api/character/identity?assistantId=` | 读人格 21 字段 |
| `POST /api/character/identity/upsert` | 写人格 |
| `GET /api/character/identity/vocab` | 拉受控词表（trait / mode / care_language / tension）|
| `GET /api/character/episodes?assistantId=&limit=&minImportance=` | 叙事段时间线 |
| `GET /api/character/episodes/:id` | 叙事段详情 |
| `POST /api/admin/character/build-episodes` | 手动触发 LLM 聚合 |
| `GET /api/character/topics?assistantId=&status=&limit=&includeInactive=` | 长期话题 |
| `POST /api/character/topics/upsert` | 手动创建话题 |
| `POST /api/character/topics/:id/status` | 7 状态机转换 |
| `POST /api/character/topics/:id/importance` | 调 importance |
| `GET /api/character/reflection?assistantId=` | 最新一条关系反思 |
| `GET /api/character/reflections?assistantId=&type=&limit=` | 反思时间线 |
| `POST /api/admin/character/reflect` | 手动触发反思 |
| `GET /api/character/behavior-intent?assistantId=` | 当前推荐意图（debug）|
| `GET /api/character/behavior-intent/vocab` | 14 个 intent 定义 |

- **客户端需要做**：**没有**。这些端点服务端 admin UI（`public/`）已用，移动端按需而定。
- **状态**：✅ 不阻塞客户端发版

### CR-04.3 LLM 生成内容风格变化（draft_title / proactive body / 反思文案）

- **服务端动作**：所有角色叙事类 LLM prompt 改为代词指代（`"你" / "ta"`），不再固化具体角色名 / 用户名字到输出。同时：
  - `proactive_plans.draftTitle` 兜底默认值由 `"${characterName} 想说"` 改为 `"想说点什么"`
  - 新生成的 `narrative_episode.title / summary / unresolvedThreads`、`relationship_reflection.summary / concerns / opportunities`、`life_event content`、`proactive_plans.draft_body` 都不再出现具体角色名
- **客户端需要做**（如果有的话）：
  1. 如果 UI 在 `draft_title` 上按角色名匹配（例如 "金宵 想说" → 显示头像或徽章），改成按 `assistantId` 匹配
  2. 如果消息列表 UI 显示 `draft_title` 当作"标题"，注意默认值现在是更通用的"想说点什么"
  3. 历史 `proactive_plans` / 历史 `assistant_turn conversation_turns` 不会被改写（只影响新生成的）
- **影响**：UI 上没破坏性，只是内容更通用化。改名功能未来添加时不需要重跑 LLM。
- **不变的部分**：
  - `memory_facts.fact_value` **仍然使用具体角色名**（设计选择，因为事实需要 anchor —— "ta 握过我的手"里的 ta 失锚）。改名时需要服务端跑批量字符串替换工具，不需重跑 LLM。
- **状态**：⏳ 客户端自检后可标记 OK

### CR-04.4 老端点 deprecated 窗口提醒（下个 release 移除）

- **将被移除**：
  - `GET /api/relationship/state` → 用 `POST /api/character/context`
  - `GET /api/character/bootstrap` → 用 `POST /api/character/context`
- **窗口长度**：1 个 release（具体日期看你们发版节奏）
- **客户端需要做**：在下次发版时迁移到 `/api/character/context`
- **状态**：⏳ 待客户端发版迁移

---

## CR-05 search_memory tool source 参数说明增强

- **服务端动作**：`/api/tool/memory-recall` 注释更新，明确 `source='character'` 仅搜 life_event/work_event（极少量角色叙事），不含用户对话内容。
- **客户端需要做**：
  1. `ToolBridge.kt` — `SEARCH_MEMORY_TOOL_SCHEMA` 的 tool description 和 source 参数 description 已更新，明确指引 LLM：
     - 用户提及的经历/感受/事件 → `source='user'`（默认）或省略
     - `source='character'` 仅用于查角色内心独白/日记
     - 不确定时用 `source='all'`
  2. 文件已改：`app/src/main/java/com/example/aichat/sync/ToolBridge.kt`
- **影响**：修复 LLM 误选 `source='character'` 导致用户相关记忆查不到（count=0）的问题。
- **状态**：✅ 客户端已改（需发版生效）

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
