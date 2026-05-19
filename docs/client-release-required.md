# 客户端配合事项

> **本文是历史 CR 清单**（每条变更需要客户端做什么）。当前 API 现状见 [api.md](api.md)。
>
> 项目无向后兼容期 —— 服务端改动直接生效，客户端必须同步。本文条目按时间留作参考。
> 服务端重构总进度见 [refactor-plan.md](refactor-plan.md)。

---

## CR-01 移除 FCM 推送注册（对应服务端 T-02）

- **服务端动作**：删除 `POST /api/register-push-token` 接口、`push_token` 表、整个 FCM 链路。
- **客户端需要做**：
  1. 移除调用 `POST /api/register-push-token` 的代码路径（启动注册 / token 刷新都不再调）。
  2. 移除 FCM SDK 集成（如果离线消息已完全走 WS + `local_outbox_messages`，FCM 已无作用）。
  3. 确认 push 通知统一走 WS `proactive` op + `queued_batch` 重连兜底。
- **影响**：
  - 调用 `POST /api/register-push-token` 服务端会返回 404。
- **状态**：✅ 服务端端点已删除（2026-05-10）。客户端如还有调用代码请尽快移除。

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

### CR-04.1 主入口端点 `POST /api/character/context`（已落地，bootstrap 已删除）

- **当前状态**：boot cache / admin / debug 端点。`GET /api/character/bootstrap` 已物理删除，客户端必须用本端点；hot path 已进一步演进到 `POST /api/chat/context`（CR-06）。
- **服务端动作**：聚合端点一次返回 7 层 payload + V_NEW_LEAN 8 个 slot + mergedSystem + assistantPrefill（不带本轮 user 上下文）。
- **客户端用法**：
  1. boot 时调一次缓存进 `CharacterBootstrapStore`，让首条消息延迟低
  2. 每轮发消息走 `POST /api/chat/context`（带 facts + narrative）
  3. 不再自己拼 identity / state / dynamics 三段
- **状态**：✅ 落地，bootstrap 已删除，relationship/state 已 dormant

### CR-04.2 admin / debug 端点

> 完整列表见 [api.md §2](api.md)。其中 `episodes/:id` / `topics/upsert` / `topics/:id/status` /
> `topics/:id/importance` / `reflection`（单数）当前 dormant，标在 [api.md §3](api.md)。

- **客户端需要做**：**没有**。这些端点服务端 admin UI（`public/`）按需调用。
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

### CR-04.4 旧端点处理（已完成）

- `GET /api/character/bootstrap` → ✅ **已物理删除**。客户端用 `GET /api/character/:id`（静态 slots）+ `POST /api/character/context`（boot cache）+ `POST /api/chat/context`（hot path）。
- `GET /api/relationship/state` → ✅ **dormant**（保留端点，未来轻量刷新状态用）。客户端从 `/api/character/context` / `/api/chat/context` 响应里 fan-out `characterState`，无需独立调用。
- **状态**：✅ 落地

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

## CR-06 V_NEW_LEAN structured chat slot + Phase 2 端点（对应服务端 Phase 1a + 1b + 2）

> 历史决策记录见 [archive/api-redesign-plan.md](archive/api-redesign-plan.md)；当前协议看 [client-prompt-merge-protocol.md](client-prompt-merge-protocol.md)；当前端点状态看 [api.md](api.md)。

### 服务端动作

1. **Prompt 渲染重构（Phase 1a + 1b）**
   - V_NEW_LEAN：`<character>` JSON 删 4 个心理深度字段（insecurities / core_wounds /
     desires / tensions）+ 3 个数值字段（emotional_sensitivity / empathy_level /
     expressiveness）—— 这些已通过 server introspection → reflection.summary →
     `<narrative>` slot 间接传递
   - 新增 `<narrative>` slot：reflection / episodes / topics 完整下放（之前压缩到 1 行
     独白片段就丢失了大量上下文）
   - 新增 `<facts>` slot：coreFacts + retrieved memories（之前完全没拼）
   - `<tool_protocol>` 占 recency bias 黄金位
   - 删除 chat 端 voice 例句（不固化句子，靠 speaking_style 描述让 LLM 自己生成）
   - `buildCharacterContext` 输出 `slots / mergedSystem / assistantPrefill`

2. **端点变化（Phase 2 — 已完成）**
   - 新增 `GET /api/character/{id}` — 静态 slots（profile + identity + 5 个 rendered slot + etag）
   - 新增 `POST /api/chat/context` — hot path 端点（每轮发消息前调）
   - 新增 `POST /api/chat/turn` 取代 `/api/sync/push`（**已物理删除旧路径**）
   - 新增 `DELETE /api/chat/turn/{turnId}` — cascade 衍生数据 + WS 推 turn_deleted

3. **删除端点（已完成）**
   - `POST /api/chat-with-memory` — 已删除
   - `GET /api/character/bootstrap` — 已删除
   - `POST /api/tool/memory-context` — 已删除
   - `POST /api/sync/push` — 已删除

### 客户端需要做

1. 新增方法已加：[ChatServerApi.kt](../../chatbox-Android/app/src/main/java/com/example/aichat/sync/ChatServerApi.kt)
   - `getCharacter(assistantId)` → ChatCharacterResponse
   - `chatContext(ChatContextRequest)` → ChatContextResponse
   - `chatTurn(ChatTurnRequest)` → ChatTurnResponse
   - `deleteChatTurn(turnId)` → DeleteTurnResponse
   - 新 DTO：[ChatDtos.kt](../../chatbox-Android/app/src/main/java/com/example/aichat/sync/ChatDtos.kt)

2. 旧方法已物理删除（`syncPush` / `characterBootstrap`）；`characterContext` 保留作 admin/debug/boot cache 端点。当前 [ChatServerApi.kt](../../chatbox-Android/app/src/main/java/com/example/aichat/sync/ChatServerApi.kt) 只剩活跃方法。

3. 实现 system prompt **canonical merge 顺序**：
   - 详细伪代码 + slot 顺序 + `<client>` slot 嵌入位置见 [client-prompt-merge-protocol.md](./client-prompt-merge-protocol.md)
   - 8 段顺序：role / character / background / constraints / facts / narrative /
     **&lt;client&gt;** / tool_protocol，末尾 assistantPrefill
   - `<client>` slot 由客户端拼，注入：`current_time` / `user_locale` /
     `device_platform` / 用户在 app 设置里写的 personalization

4. **tool 循环 UX**：
   - DeepSeek-V3 调 search_memory 时**默认 content 为空**（OpenAI 标准）；客户端
     SDK 必须实现 stage1 + stage2 两阶段（见 protocol 文档 §5）
   - stage1 没 content 时 UI 显示伪造占位 "正在查找相关记忆..."

### 影响

- 老路径全部物理删除（`/api/sync/push` / `/api/character/bootstrap` / `/api/tool/memory-context` / `/api/chat-with-memory`）— 调用 → 404
- 客户端用 `chatContext` 拿到结构化 slots → system prompt 更精准（V_NEW_LEAN 实测 tool 触发率 72% → 92%，正确跳过 80% → 90%）

### 状态

- ✅ 服务端落地（Phase 1a / 1b / 2 + cleanup 共 7 个 commit on dev branch）
- ✅ Android API 客户端方法 + DTO 已加
- ✅ **Android 现有 caller 完整迁移**：
  - `SyncQueueDrainer.kt` syncPush → chatTurn（字段映射 ingested/deduped/rejected）
  - `CharacterBootstrapStore.kt` 缓存 schema `promptFragment` → `mergedSystem`，doRefresh
    fallback 路径删除（仅走 `/api/character/context`）
  - `CharacterMemoryService.kt` getMemoryContext 改用 `/api/chat/context`
  - `CharacterMemoryApi.kt` 删 PATH_MEMORY_CONTEXT + MemoryContextRequest
  - `ChatServerApi.kt` 删 syncPush / characterBootstrap 旧方法；保留 characterContext 作
    admin/debug/boot cache 用
  - `ChatViewModel.kt` buildBootstrapPrefixIfAny 改用 cache.mergedSystem

---

## CR-07 setup_prompt + lore + LLM-assisted persona extraction（Phase 3）

### 服务端动作

1. **Schema migration 032**：assistant_profile 加 4 列
   - `setup_prompt` — 用户原始输入（archive，不直接进 prompt）
   - `lore` — LLM 提炼后的纯叙事段（渲染进 `<background>` slot）
   - `extraction_status` — pending / ready / failed / skipped
   - `extraction_error` / `extracted_at`
   - 老 `character_background` 保留作 fallback；写入时 dual-write

2. **新增端点**：
   - `POST /api/character/extract` — dry-run preview（接受 setupPrompt 或 assistantId）
   - `POST /api/character/lore/save` — 保存修改后的 lore

3. **异步触发**：assistant-profile/upsert 后，setup_prompt 改了 + character/空 type
   → emit `profile.setup_prompt.changed` event → personaExtraction subscriber
   `setImmediate` 跑 LLM 提炼 → 更新 identity + lore + status

4. **promptComposer.renderBackgroundSlot** 优先用 `profile.lore`，fallback `character_background`

5. **admin UI** identity tab 加 "🤖 AI 分析 setup_prompt" 按钮 + preview dialog
   （在 [public/app.js](public/app.js) `renderIdentityTab` + `showExtractPreviewDialog`）

### 客户端需要做

1. **`assistant-profile/upsert` 响应**新增字段（不破坏旧结构，仅新增）：
   - `setupPrompt` / `lore` / `extractionStatus` / `extractedAt`
   - 旧客户端忽略即可（仍能读 characterBackground）

2. **新角色编辑流程**（Android EditMyAssistantActivity 或 web）：
   - 用户填 setup_prompt（沿用现 characterBackground 字段提交即可，server 端 dual-write）
   - 提交后异步触发 LLM 提炼（用户感知不到延迟）
   - 编辑入口可加 "AI 分析" 按钮调 `/api/character/extract` 看 preview
   - apply 调 `/api/character/identity/upsert` + `/api/character/lore/save`

3. **chatbox-Android caller 适配**（visible 字段，可选）：
   - `CharacterBootstrapStore` 缓存 etag 同时记 `extractionStatus`
   - 显示"角色分析中…"占位（status='pending' 时）

### 影响

- 老调用 `assistant-profile/upsert` 完全兼容（多了字段）
- Phase 1a `<background>` slot 内容会变化：
  - LLM 提炼跑过 → 显示净化后的 lore（更短、更聚焦）
  - 提炼失败 / pending → 显示原始 character_background（fallback）

### 设计意图

用户写的 setup_prompt 是混合体（lore + 风格 + 系统指令）。三类分离后：
- 风格指令 → identity.speaking_style 字段（结构化）
- 边界 → identity.hardBoundaries / softBoundaries
- 系统指令 → 删除（应该升格成 system-level rule）
- lore → 纯叙事段进 `<background>` slot

零重复 → 降低 LLM 注意力稀释（之前 ab-prompt-test 证明的问题）。

### 状态

- ✅ 服务端落地（migration + service + endpoints + subscriber + admin UI 按钮）
- ⏳ 现有 5 角色 batch re-extract（等本地 Qwen 在线时跑：在 admin UI identity tab 点"AI 分析"）
- ⏳ chatbox-Android EditMyAssistantActivity 适配（视产品需求）

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
