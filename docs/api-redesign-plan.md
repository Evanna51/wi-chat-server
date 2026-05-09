# API 重构计划 — 从客户端生命周期反推

**Status**: Draft · 2026-05-10
**Authors**: Evanna + Claude
**Replaces**: 散落的 `/character/context` + `/character/bootstrap` + `/tool/memory-context` + `/tool/memory-recall` + `/chat-with-memory` 等 6+ 个端点

---

## 0. 重构动机

当前 HTTP 表面层是按"服务边界"切的，客户端要自己学会"调用矩阵"才能拼出一次 LLM 调用。这次重构**反过来从客户端视角**重新组织：客户端在不同生命周期点该调谁、拿到什么、怎么用。

**不重写**：`characterStateService` / `relationshipDynamicsService` / 7 层认知态 / memory retrieval 内核 — 这些已经经过 CC-1~CC-5 五轮迭代，都不动。

**只重写**：HTTP 端点的命名/分组/合并、system prompt 渲染（落 V_NEW 结构化）、客户端 merge 协议文档化。

---

## 1. 客户端生命周期（Android · WS-first）

```
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│  [App 启动 / 切换角色]                                                 │
│       ↓                                                                │
│   1. 拉角色档案（profile + identity + tool_protocol schema）           │
│       ↓                                                                │
│   2. 拉用户事实（coreFacts / pinned）                                  │
│       ↓                                                                │
│   3. WS 建连接（接 server 推 delta）                                   │
│                                                                        │
│  [发消息 hot path · 频繁]                                              │
│       ↓                                                                │
│   4. 拉本轮上下文（state snapshot + retrieved memory + assistantPrefill│
│       ↓                                                                │
│   5. 客户端拼 system → 调 LLM → 拿回复（客户端 SDK 处理 tool 循环）    │
│       ↓                                                                │
│   6. 上传这一轮（user + assistant turns）— 异步，不阻塞 UI             │
│                                                                        │
│  [server 异步推断 · 客户端不等]                                        │
│       ↓ ws push 或下次 sync                                            │
│   7. 收 delta：state / episode / reflection / proactive plan           │
│                                                                        │
│  [每日定期 sync]                                                       │
│       ↓                                                                │
│   8. 拉变更（since cursor）                                            │
│                                                                        │
│  [删除路径 · 用户 / 软件触发]                                          │
│       ↓                                                                │
│   9. 删 turn → server 级联清理（episode link 等）→ ws 推所有客户端     │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

每条都对应一个端点（或 WS 事件）。下面把它们打包成最少的端点集合。

---

## 2. system prompt 拼接策略（客户端视角）

客户端每轮发消息前，要把以下 8 类输入合并成一个 system string（按 merge 顺序）：

| 类 | slot | 来源 | 频率 | 谁拼 |
|---|---|---|---|---|
| A | `<role>` | 1 句固定指令 | 静态 | server |
| B | `<character>` | profile + 精简 identity | 静态/慢变 | server |
| C | `<background>` | profile.character_background lore | 静态 | server |
| D | `<constraints>` | identity boundaries / avoidance | 静态 | server |
| E | `<facts>` | coreFacts + retrieved memories（**客观事实**） | 半动态（每轮变） | server |
| F | `<narrative>` | reflection + episodes + topics（**角色主观叙事**） | 半动态 | server |
| G | `<client>` | 当前时间、locale、设备语境、用户自定义指令 | 每轮变 | **客户端** |
| H | `<tool_protocol>` | tools 定义 + 调用协议 | 静态 | server |
| — | `[此刻]` (assistantPrefill) | mood + dynamics 异常片段 | 半动态 | server |

### 客户端 merge 顺序（**协议固定，写进文档强制**）

```
<role>...</role>                          ← server slot
<character>{...}</character>              ← server slot (JSON)
<background>...</background>              ← server slot (lore prose)
<constraints>{...}</constraints>          ← server slot (JSON)
<facts>...</facts>                        ← server slot (coreFacts + retrieved)
<narrative>{...}</narrative>              ← server slot (reflection + episodes + topics)
<client>                                  ← ★ 客户端追加点 ★
  current_time: 2026-05-10T18:00:00+08:00
  user_locale: zh-CN
  custom_instructions: ...
</client>
<tool_protocol>{...}</tool_protocol>      ← server slot（recency bias 黄金位）

[此刻]                                    ← assistantPrefill（独立段，不在 system 内）
内心独白...
```

**位置语义**：
- `<facts>` 客观事实 + `<narrative>` 角色主观叙事 — 语义连续，合放
- `<client>` 紧跟在 server 数据之后、`<tool_protocol>` 之前 — 客户端可注入本地语境
- `<tool_protocol>` 占 recency bias 黄金位（LLM 决策 tool 调用时刚扫过协议）

### `<narrative>` slot 内容（修正：之前漏了这一层）

server 已经有完整的"角色主观叙事"数据（reflection / episodes / topics 三张表），之前**只有最 prominent 的 1 条压缩进 prefill 独白**，客户端 LLM 看不到完整列表。修正为：

```jsonc
{
  "recent_reflection": {                  // 最新 1 条 fresh reflection
    "summary": "...",                     // 200 字 cap
    "direction": "deepening|cooling|stable|tense|reconnecting",
    "user_needs": [...],
    "concerns": [...],
    "opportunities": [...]
  },
  "active_episodes": [                    // top 3 by importance
    { "title", "summary", "emotional_tone", "unresolved_threads", "importance" }
  ],
  "active_topics": [                      // top 5 active by recency × importance
    { "topic", "status", "emotional_association", "last_discussed_at" }
  ]
  // attention_window_1h: 暂不实现，见附录 B
}
```

**预算估算**：~800 字 / ~300 tokens — 可控。

---

## 2.5 Two prompt families — 区分使用场景

整个系统有**两类完全不同的 LLM 场景**，prompt 应该按 family 分开设计，**不能用同一套**。

| 维度 | Family 1 — Chat | Family 2 — Introspection |
|---|---|---|
| LLM provider | 客户端选（DeepSeek-V3 等大模型） | server 本地（Qwen 7B-9B 等小模型） |
| 调用者 | mobile / web 客户端 | server 内部 6 个 service |
| 目的 | turn-taking 对话回应 | 生成 reflection / episode / 主动消息 / 分类 / 决策 — **角色主观输出**，非对话 |
| 数据访问 | 通过 `<tool_protocol>` 调 server tool | server god-mode 直接 SQL |
| Token 约束 | **强**（每轮 API 收钱） | **弱**（本地模型量大不心疼） |
| Prompt 风格 | XML envelope + JSON 字段（大模型擅长结构化） | Markdown `── 段标 ──` + 第一人称指令（小模型对 prose 友好；当前 [reflectionService.js:201-249](src/services/character/reflectionService.js:201) 即此风格） |
| 必备 slot | role / character / background / constraints / facts / narrative / client / tool_protocol | role / persona（**全字段**）/ facts / 关系全状态 / episodes 完整 / reflections history / 最近 turns / **task 定义** |
| **不需要** | — | tool_protocol、client slot、assistantPrefill |
| 字段策略 | **精简** | **保留全部** + server-only 字段 |

### Family 1 — Chat 字段策略

`<character>` slot 包含字段（精简版）：

| 等级 | 字段 | 处置 |
|---|---|---|
| 强（保留） | name, role_title, gender_expression, speaking_style, personality_traits, attachment_style, values, care_languages, worldview | `<character>` |
| 强（保留） | hard_boundaries, soft_boundaries, avoidance_topics, triggering_topics | `<constraints>` |
| **删除** | insecurities, core_wounds, desires, tensions | 已通过 reflection 编码 → `<narrative>` 间接传递 |
| **删除** | emotional_sensitivity / empathy_level / expressiveness（数值） | LLM 不直接消费数值；驱动 dynamics 计算 → `[此刻]` 间接 |

数据流：`深度字段 → server 跑 introspection LLM 生成 reflection → reflection.summary 进 <narrative> → chat LLM 看到`。这条链路自洽，chat 不需要重复塞原始深度字段。

### Family 2 — Introspection 字段策略

**保留全部** identity 字段（含心理深度）+ 加 server-only 富数据：
- `dynamics` 全 12 维数值（`<persona>` 段）
- `episodes` 完整列表（不只 top 3）
- `reflections` history（递进性反思需要看上一次）
- 最近 `turns` 8-16 条原文

不需要 `<tool_protocol>` —— server 直接 SQL，无需工具。

### A/B 验证

落生产前 A/B：V_NEW（保留全字段）vs V_NEW_LEAN（chat 删 4+3 字段）。本次只验证 chat family；introspection family 因为没有 token 压力，先一次性收编再观察。

---

## 3. API 端点（按客户端生命周期分组）

**5 个核心端点 + 3 个工具端点 + WS 通道**。命名遵循"客户端在做什么"：

### 3.1 `GET /api/character/{assistantId}`
**时机**：App 启动 / 切换角色
**取代**：`/character/bootstrap` + `/character/identity` + 部分 `/api/browse/assistants`
**返回**：
```jsonc
{
  "assistantId": "...",
  "profile": { name, background, ... },
  "identity": { ...selected fields... },
  "renderedSlots": {
    "role":        "<role>...</role>",         // 已渲染好
    "character":   "<character>{...}</character>",
    "background":  "<background>...</background>",
    "constraints": "<constraints>{...}</constraints>",
    "tool_protocol": "<tool_protocol>{...}</tool_protocol>"
  },
  "etag": "v1.0:identity_v3:profile_v2"     // 客户端可以缓存到 etag 变化
}
```

客户端**长缓存**这套 slots（identity 升级才失效）。

### 3.2 `POST /api/chat/context`
**时机**：每次发消息前（**hot path**）
**取代**：`/character/context` + `/tool/memory-context`
**入参**：
```jsonc
{
  "assistantId": "...",
  "sessionId":   "...",
  "userInput":   "...",                  // 必传，决定 retrieve query 和 salient phrase
  "haveSlotsETag": "v1.0:identity_v3:..."  // 可选；如果 server 端 slots 没变就返回 304-like 的小 payload
}
```
**返回**：
```jsonc
{
  "facts":       "<facts>...</facts>",      // coreFacts + retrieved（客观事实）
  "narrative":   "<narrative>{...}</narrative>", // reflection + episodes + topics（角色主观叙事）
  "assistantPrefill": "[此刻]\n...",         // 角色当下心境独白
  "salientPhrase": { ... },                 // 可选，UI 高亮用
  "memoryDecision": { shouldRetrieve, intent, source },  // 调试可见
  "stateVersion":  "...",                   // 客户端可记下来，sync 时比对
  // 如果客户端 etag 过期，附带新 slots
  "renderedSlots": null | { role, character, ... }
}
```

**关键设计**：客户端只调 1 次端点，拿到所有动态数据（facts / narrative / prefill）+ 静态 slots（如有更新）。

### 3.3 `POST /api/chat/turn`
**时机**：发完一轮（user message + AI 回复都生成完）
**取代**：`/api/sync/push`（部分场景）+ `chat-with-memory` 后半截
**入参**：
```jsonc
{
  "assistantId": "...",
  "sessionId":   "...",
  "turns": [
    { "id": "client-uuid-1", "role": "user",      "content": "...", "ts": 1234 },
    { "id": "client-uuid-2", "role": "assistant", "content": "...", "ts": 1235,
      "toolCalls": [...],                              // 可选，调试/审计
      "metadata": { llmModel, llmProvider, ... }      // 可选
    }
  ]
}
```
**副作用**（已有 event-driven 实现）：
- 落 conversation_turns
- emit `turn.user.batch` → cancelPendingPlans / characterStateUpdater / scheduleNextPush
- 异步触发 memory_classification

**返回**：`{ ok, ingested, deduped }` — 不返回新 state（客户端通过 ws/sync 拿）。

**WS 等价路径**：通过 ws message 发等价 payload，server 走同一个 ingestTurnsBatch 路径。WS 断联时降级到 HTTP。

### 3.4 `GET /api/sync/since`
**时机**：每日定时 / WS 断线重连后
**取代**：当前 `/api/sync/*` 杂项
**入参**：`?cursor=2026-05-09T03:00:00Z&assistantId=...`
**返回**：
```jsonc
{
  "events": [
    { "type": "state_changed",   "data": {...} },
    { "type": "episode_created", "data": {...} },
    { "type": "reflection_new",  "data": {...} },
    { "type": "turn_deleted",    "data": { turnId, cascade: { episodeIds, ... } } },
    { "type": "facts_changed",   "data": { added, removed } }
  ],
  "nextCursor": "..."
}
```

### 3.5 `DELETE /api/chat/turn/{turnId}`
**时机**：用户删消息
**副作用**：删 row + cascade（episode_memory_link / memory_facts 衍生数据） + WS 推 `turn_deleted` 给所有客户端 + 触发 state 重算
**返回**：`{ ok, cascadeCount }`

### 3.6 工具端点（保留，命名不动）
- `POST /api/tool/memory-recall` — 客户端在 LLM tool-loop 里调
- `POST /api/tool/memory-correct` — 校正错误记忆
- `POST /api/tool/knowledge-add` — 写知识库

### 3.7 WS 通道事件（server → client）
```
state_changed         server 推断完 state 后
episode_created       新 episode 落库
reflection_new        新 reflection 落库
turn_deleted          其他端删了 turn
facts_changed         coreFacts 增删
proactive_message     主动消息推送（已有）
```

---

## 3.8 promptComposer 模块（实现层支撑）

把当前散在 6 个 service 的 hand-rolled prompt 收编到统一模块，两个 family 共享底层 building blocks。

### 模块结构

```
src/services/character/promptComposer.js
├── composeForChat({...})              → 返回 chat 的 8 个 slot（XML+JSON 风格）
│       使用方：/api/chat/context
│
├── composeForIntrospection({task, ...}) → 返回完整 prompt 字符串（markdown 风格）
│       使用方：reflectionService / episodeBuilder / catchupService /
│             proactivePlanService / memoryClassificationService /
│             memoryDecisionService
│       task: { type, instructions, output_schema }
│
└── 共享 building blocks：
    ├── renderRolePersona({ identity, mode: "chat"|"introspection" })
    │     mode=chat → 9 字段 JSON
    │     mode=introspection → 全字段 + dynamics + 第一人称指令
    ├── renderConstraints(identity)         → 共用
    ├── renderBackground(profile)           → 共用（chat / introspection 都需要 lore）
    ├── renderFacts({ coreFacts, retrieved }) → chat only（XML+JSON）
    ├── renderNarrative({ reflection, episodes, topics }) → chat only
    ├── renderToolProtocol()                → chat only
    └── renderTaskBlock({ type, schema })   → introspection only
```

### 实际收编范围（务实评估）

Plan 初稿写"6 service 全收编"，落地时发现差异化大、强行统一会改 LLM 输出。务实评估后实际收编：

| service | character_background | identity 描述 | 处置 |
|---|---|---|---|
| `episodeBuilder` | ✅ 共享 `renderBackgroundForIntrospection` | 不用 | **已收编** |
| `catchupService` | ✅ 同上 | 不用 | **已收编** |
| `proactivePlanService` (plan) | ✅ 同上 | 不用 | **已收编** |
| `proactivePlanService` (next_push) | ✅ 同上 | 不用 | **已收编** |
| `reflectionService` | 不用 | hand-rolled `identitySummary`（1 行紧凑） | **保留 service-local** —— 形态独立、风险大于收益 |
| `memoryClassificationService` | 不用 | 不用（纯 NLP task） | **不参与** |
| `memoryDecisionService` | 不用 | 不用（纯 NLP task） | **不参与** |

**已收编（Phase 1b 落地）**：4 处 `clipText(characterBackground \|\| "无", N)` 模式 →
`promptComposer.renderBackgroundForIntrospection(characterBackground, N)`。默认行为与
原实现完全一致（不剥"系统提示"段、ASCII `...` trim、whitespace strip），LLM 输出零变化。

**未收编（保持 service-local）**：reflection 的 identitySummary、各 service 的 prompt
主结构 / 字段 layout / output schema 描述。这些与 task 强耦合，强行统一只会增加间接层。

**收编收益（修正版）**：
- 未来 character_background schema 变化（如 task C 拆"系统提示"段）只改一处
- `composeForChat` + `renderBackgroundForIntrospection` 让两个 family **共享同一个**
  background 渲染逻辑（chat 走 stripSystemHints=true，introspection 走 false，可单独切换）

**未来 followup**（如有需要）：
- reflection identitySummary 收编（如果新增类似 task 时再做）
- 其它 service 的字段渲染共享（视产品需求）

---

## 4. content 空问题的两条路径

DeepSeek-V3 默认 tool-call 不带 content。100% 保证 "永远有 content" 只能靠工程，不是 prompt。提供两条路径，**客户端选**：

### 路径 A：客户端自己包 tool 循环（推荐）

客户端 SDK 提供 helper：
```
1. client → DeepSeek 第一轮 → 拿 { content?, toolCalls? }
2. if toolCalls:
     for each tc:
       client → POST /api/tool/memory-recall → 拿 results
     client → DeepSeek 第二轮（喂 tool result）→ 拿 final content
3. 合并 stage1.content（如有）+ stage2.content → 渲染给用户
```

UI 体验：stage1 没 content 时显示客户端伪造的 "正在查找相关记忆..." 占位，stage2 拿到后替换。

**优点**：
- 客户端控 LLM key（用户自带 OpenAI key 等）
- server 不代理 LLM，无延迟、无 key 风险
- 客户端可流式渲染（如果 LLM 支持）

**缺点**：
- 客户端要实现 tool loop（SDK 帮一下）
- 需要"查询中..."占位 UI

### 路径 B：server 代理（可选，给不想自己处理 tool 循环的客户端）

新端点 `POST /api/chat/complete-with-tools`：
```
1. 入参：{ system, messages, model, ... }
2. server 代理 LLM 调用 + tool 循环
3. 返回：{ content (保证非空), toolCallsExecuted, ... }
```

**优点**：
- 客户端无需 tool loop
- 永远拿到 content

**缺点**：
- server 要持有 LLM key（成本归 server）
- 不支持流式（除非额外做 SSE 转发）
- 增加 server 负载

**决策（决策点 4 ✅）**：**只做路径 A**。已有 `/api/tool/memory-recall` 直接复用，客户端 SDK 加 tool-loop helper。路径 B 仅作为对比说明保留，不在落地范围。

---

## 5. 数据流：WS 实时 + 每日 sync 的更新模型

### 一致性保证
- **客户端权威**：消息（user + assistant turns）以客户端 local DB 为最终真理
- **server 异步推断**：state / episode / reflection / facts 是 server 基于 user turn 推断出来的衍生数据
- **WS 推送 = 实时通道（不可靠）**：低延迟，但断联时丢消息
- **每日 sync = 兜底通道（可靠）**：cursor-based，永远能补齐

### 推送 / 同步的 idempotency
- `chat/turn` 入参带客户端 uuid (`turns[].id`)，server 去重
- `sync/since` 用 cursor，幂等

### 删除路径细节

```
用户在 client A 删一条 turn
   ↓
client A → DELETE /api/chat/turn/{id}
   ↓
server 在事务里：
   - 删 conversation_turns row
   - 找出依赖它的 episode_memory_link → 删
   - 找出依赖它的 memory_facts → 标记 origin_deleted（不直接删，避免 retrieval cache 失配）
   - 触发 state 重算（如果这条 turn 在最近 N 轮里）
   - WS 推 turn_deleted 事件给该 user 的所有 client
   ↓
client B 收到 ws turn_deleted → 删本地 row + 触发本地视图刷新
client A 自己已经删了，会去重
```

---

## 6. 落地阶段（按依赖排序）

### Phase 1a: Chat prompt 渲染重构（client-facing，不破坏 API）

新建 `src/services/character/promptComposer.js`，初版只实现 `composeForChat`：
1. 实现 `renderRolePersona({mode:"chat"})` / `renderConstraints` / `renderBackground` / `renderFacts` / `renderNarrative` / `renderToolProtocol` 等 building blocks
2. `composeForChat` 输出 8 个 slot（含 narrative）
3. 当前 `/character/context` 端点同时返回 `system`（合并好的，向后兼容）+ `slots`（新字段，分段）
4. `composeForChat` 内部按 chat 字段策略过滤 identity（删 4 心理深度字段 + 3 数值）
5. **A/B 验证 V_NEW_LEAN（精简版，落生产候选）vs 当前生产 V1**（用金宵 — skills_json + pronouns 已通过 [scripts/patch-jinxiao-identity.js](scripts/patch-jinxiao-identity.js) 补全）
6. 保留 prefill 现状（精简 prefill 移到 TODO，见附录 B）

**完成标准**：现有客户端无变化；新客户端能开始用 `slots`（含 narrative）字段。

### Phase 1b: Introspection 渲染收编（实际落地范围）

务实评估后，实际收编**只共享 character_background 渲染**（4 service）。其余各 service
的 prompt 主结构 / identity 描述 / output schema 差异化大，强行统一风险大于收益，
保留 service-local。

**已落地**（commit 146806e）：
1. promptComposer.js 暴露 `clipText` + `renderBackgroundForIntrospection(string, N, opts)`
   building block，默认行为与现有 4 service 自定义 clipText 完全一致
2. episodeBuilder / catchupService / proactivePlanService（plan + next_push）4 处
   `clipText(characterBackground || "无", N)` → `renderBackgroundForIntrospection(...)`
3. 跑回归测试 546/546 passed

**完成标准** ✅：4 个 service 的 LLM 输出 prompt 字符串保持完全一致（默认
stripSystemHints=false 与原实现等价）。

**未落地** (followup，如有需要再做)：
- `composeForIntrospection({task, ...})` 高层 helper（评估后认为间接层无实际收益）
- reflection identitySummary 共享渲染
- introspection 字段全字段第一人称模板

**1a / 1b 关系**：1a / 1b 在同一批 commit 序列里完成（共享 promptComposer 文件），
1a 提供 chat slot 渲染，1b 抽出 introspection 共享 building block。两个 family
现在共享 `clipText` 这个底层工具 + `<background>` 渲染逻辑（chat 走
stripSystemHints=true，introspection 走 false，可单独切换）。

### Phase 2: 端点合并 + 命名规范化 ✅ 已完成

**已落地**（[src/routes/chat.js](src/routes/chat.js)）：
1. ✅ 新建 `POST /api/chat/context`（内部 `buildCharacterContext` + `shouldRetrieveMemory` +
   `retrieveMemory` + `composeForChat` 组装，返回 facts / narrative / prefill / etag）
2. ✅ 新建 `GET /api/character/{id}` 取代 `/character/bootstrap`，返回 etag-able 静态 slots
3. ✅ 新建 `POST /api/chat/turn` 取代 `/api/sync/push`（行为完全等价，内部调同一
   `ingestTurnsBatch` + emit `turn.user.batch` 触发同样 subscribers）
4. ✅ 新建 `DELETE /api/chat/turn/{turnId}`（cascade 衍生数据清理）
5. ✅ **删除 `POST /chat-with-memory`**（决策点 6 — 无客户端调用，server 内部不依赖）
6. ✅ 4 个旧端点加 `Deprecation: true` + `Link: <successor>; rel="successor-version"` header：
   - `POST /api/character/context` → `/api/chat/context`
   - `GET /api/character/bootstrap` → `/api/character/{id}`
   - `POST /api/tool/memory-context` → `/api/chat/context`
   - `POST /api/sync/push` → `/api/chat/turn`
7. ✅ 测试 546/546 passed；smoke test 验证 4 新端点 + 旧端点 deprecation header 正常

**`GET /api/sync/since` 推迟**：当前 `/api/sync/state` 是 counters（不是 events stream），
`outbox_events` 表的 cursor-based 拉取设计较复杂；现有 WS 通道 + sync/state 已能满足需求，
since 端点视后续真实需求再做。

**完成标准** ✅：新客户端能完全不调旧端点。客户端 chatbox-Android 已添加新方法
（[ChatServerApi.kt](../chatbox-Android/app/src/main/java/com/example/aichat/sync/ChatServerApi.kt)
+ [ChatDtos.kt](../chatbox-Android/app/src/main/java/com/example/aichat/sync/ChatDtos.kt)），
旧方法标 @Deprecated 但保留兼容。

### Phase 3: 客户端 SDK 与协议文档
1. 写 `docs/client-prompt-merge-protocol.md` — canonical merge order + `<client>` slot 用法 + tool-loop 伪代码
2. 提供 Android 参考实现（如果项目里能放）
3. mobile 团队按文档实现

**完成标准**：mobile 切到新端点 + 新 system 结构。

### Phase 4: 旧端点下线
1. 老端点 logger 监控调用量降到 0
2. 删除老端点 + 老 buildSystemSegment 旧分支

---

## 7. 决策点 — 全部已确认 ✅

1. **Chat 字段取舍** ✅ 删 4 心理深度（insecurities / core_wounds / desires / tensions）+ 3 数值（emotional_sensitivity / empathy_level / expressiveness）。落生产前 A/B 验证。
2. **`<client>` slot 位置** ✅ 放在 `<narrative>` 后、`<tool_protocol>` 前。
3. **`<narrative>` slot 设计** ✅ 含 reflection / episodes / topics 三类完整数据；attention_window_1h 暂不做（见附录 B）。
4. **content 空问题** ✅ MVP 走路径 A（客户端 SDK 包 tool loop + UI 占位）。
5. **API 端点最终命名** ✅
   - `GET /api/character/{id}`
   - `POST /api/chat/context`
   - `POST /api/chat/turn`
   - `GET /api/sync/since`
   - `DELETE /api/chat/turn/{id}`
   - `POST /api/tool/memory-recall` / `memory-correct` / `knowledge-add`
6. **`/chat-with-memory`** ✅ **删除**（不保留为 fallback）。
7. **A/B 角色选择** ✅ 用金宵（已通过 [scripts/patch-jinxiao-identity.js](scripts/patch-jinxiao-identity.js) 补全 skills_json + pronouns，identity_version 1→2）。
8. **Phase 1b 收编节奏** ✅ 一次性落地。务实评估后实际范围 = 4 service 共享 character_background 渲染（reflection identitySummary / classify / decision 风险大于收益，保留 service-local）。
9. **本地模型升级** ✅ 暂不调整（保持当前 Qwen），1b 完成后视效果再说。

---

## 附录 A：当前 → 新端点映射表

| 当前 | 新 | 状态 |
|---|---|---|
| `GET /character/bootstrap` | `GET /api/character/{id}` | ✅ 新建 + 旧加 Deprecation |
| `GET /character/identity` | `GET /api/character/{id}` 含 identity 字段 | 旧仍可用（admin UI 用） |
| `POST /character/context` | `POST /api/chat/context` | ✅ 新建 + 旧加 Deprecation |
| `POST /tool/memory-context` | `POST /api/chat/context` 内部组合 | ✅ 客户端不再单独调；旧加 Deprecation |
| `POST /tool/memory-recall` | `POST /api/tool/memory-recall` | 不变（agentic tool） |
| `POST /tool/memory-correct` | `POST /api/tool/memory-correct` | 不变（agentic tool） |
| `POST /tool/knowledge-add` | `POST /api/tool/knowledge-add` | 不变 |
| `POST /chat-with-memory` | — | ✅ **已删除**（决策点 6） |
| `POST /api/sync/push` | `POST /api/chat/turn` | ✅ 新建 + 旧加 Deprecation |
| `POST /api/sync/snapshot` | `POST /api/sync/snapshot` | 不变（assistants + turns 一次性同步，与 chat/turn 语义不同） |
| `GET /api/sync/state` | `GET /api/sync/state` | 不变（简单 counters）；`/api/sync/since` 推迟，见 §6 Phase 2 |
| — | `DELETE /api/chat/turn/{id}` | ✅ 新增 |

---

## 附录 B：本计划**不**包含的事 + TODO

### 不包含
- 客户端 LLM provider 切换 / multi-LLM 路由
- 流式响应（SSE / WS streaming）—— 当前 hot path 不流式
- character_background 末尾"系统提示"段从 DB 拆出（task C，独立 PR）
- 多设备 active state 同步（同一 user 多个设备同时在线时的 state merge）

这些后续单独立项。

### 后续 TODO（Phase 1 完成后视效果决定）

- **TODO-1: assistantPrefill 精简实验**
  当前 prefill 含 7 项（salient / mood / dynamics / suppressed / episode / topic / reflection）。`<narrative>` slot 落地后，episode / topic / reflection 三项已经在 narrative 里完整给到 LLM，prefill 中的精简版属于冗余。
  实验方案：把 prefill 精简成只有 mood + dynamics top1（前 4 项），观察对话质量是否退化。**先观察生产效果再决定**。

- **TODO-2: attention_window_1h（pending plans 注入 chat）**
  proactive_plans 里 `status='pending'` 且 `scheduled_at < now + 1h` 的项，目前在用户开口后被 cancelPendingPlans 粗暴全部取消。新方案：给 chat LLM 看到这些 pending intent，让它决定揉进 / 延后 / 直接说。
  影响 cancelPendingPlans subscriber 稳定性，单独立项。

- **TODO-3: introspection prompt 风格统一前的事实采集**
  收编 6 个 service 前先采集每个 service 当前 prompt 的字符数、字段引用清单、输出 schema，作为迁移后回归测试的对比基线。

- **TODO-4: 本地模型实测**
  introspection prompt 富化后实测 Qwen 7B 输出质量；如果质量退化，切换到 9B / 14B 或在 .env 里增加 `INTROSPECTION_LLM_MODEL` 单独配置。
