# Client Prompt Merge Protocol

**Status**: Active · 2026-05-10
**Audience**: 客户端开发（mobile / web / 第三方）
**Server endpoints**: `GET /api/character/{id}` + `POST /api/chat/context`

---

## 1. 背景

服务端把 system prompt 拆成 8 个 XML slot，由 server 渲染好成段，**客户端按 canonical
顺序拼接**，并在指定位置插入自己的 `<client>` slot（本地时间 / locale / 用户自定义指令）。

为什么不让 server 拼好整段？—— 客户端有些上下文（当前时间、设备 locale、用户在 app 设置
里写的 personalization）server 拿不到 / 拿不准；client 直接知道。

---

## 2. Slot 列表

| 顺序 | Slot | 来源 | 频率 | 客户端动作 |
|---|---|---|---|---|
| 1 | `<role>` | server `getCharacter` / `chatContext` | 静态 | 直接放最顶 |
| 2 | `<character>` | server | 静态 | 跟在 role 后 |
| 3 | `<background>` | server | 静态 | lore prose |
| 4 | `<constraints>` | server | 静态 | hard / soft boundaries JSON |
| 5 | `<facts>` | server `chatContext` | 半动态（每轮变） | coreFacts + retrieved memories |
| 6 | `<narrative>` | server `chatContext` | 半动态 | reflection / episodes / topics |
| 7 | `<client>` | **客户端** | 每轮变 | **客户端自己拼** |
| 8 | `<tool_protocol>` | server | 静态 | recency bias 黄金位 |
| — | `[此刻]` (assistantPrefill) | server `chatContext` | 半动态 | 末尾独立段 |

---

## 3. Canonical merge 顺序（**协议固定**）

```
<role>...</role>

<character>{...}</character>

<background>...</background>

<constraints>{...}</constraints>

<facts>...</facts>

<narrative>{...}</narrative>

<client>
{客户端本地数据}
</client>

<tool_protocol>{...}</tool_protocol>

[此刻]
{assistantPrefill 内心独白}
```

每段之间用 `\n\n` 分隔。`<client>` 必须放在 `<narrative>` 之后、`<tool_protocol>` 之前。

### `<client>` slot 内容建议（你可以增删字段）

```
<client>
{
  "current_time": "2026-05-10T18:30:00+08:00",
  "user_locale": "zh-CN",
  "device_platform": "android",
  "custom_instructions": "用户在 app 设置里写的 personalization，可空"
}
</client>
```

格式建议 JSON（与 server slot 风格一致）；YAML / 自由文本也行 —— LLM 都能解析。

---

## 4. 客户端调用流程

### 4.1 App 启动 / 切换角色

```
1. 调 GET /api/character/{assistantId}
2. 缓存到本地：profile + identity + 5 个静态 slot + etag
3. WS 连接（接 server 推 delta）
```

### 4.2 每轮发消息（hot path）

```
1. 客户端拼用户输入字符串 userInput
2. 调 POST /api/chat/context
   body: { assistantId, sessionId, userInput, haveSlotsETag: <缓存的 etag> }
3. 拿到 response：
   - facts / narrative / assistantPrefill        ← 总是有
   - renderedSlots                               ← 仅 etag 失配时有；客户端更新缓存
   - memoryDecision                              ← debug / 监控用
   - etag                                        ← 客户端更新本地缓存的 etag
4. 客户端按 canonical 顺序拼 system prompt（含 <client> slot）
5. 客户端调 LLM（DeepSeek / OpenAI / etc.）+ 处理 tool 循环（见 §5）
6. 拿到 LLM 最终回复 → UI 显示
7. 异步调 POST /api/chat/turn 上传 user + assistant turn
```

### 4.3 上传一轮

```
POST /api/chat/turn
body: {
  deviceId: "stable-uuid",
  turns: [
    { id: "client-uuid-1", assistantId, sessionId, role: "user",      content, createdAt },
    { id: "client-uuid-2", assistantId, sessionId, role: "assistant", content, createdAt }
  ]
}
```

`turns[].id` 是客户端生成的 UUIDv7；server 用它去重，可以重试任意次。

### 4.4 删除一条消息

```
DELETE /api/chat/turn/{turnId}
→ server 删行 + cascade（衍生 memory_items / facts / episode_links）
+ WS 推 turn_deleted 给所有客户端（含本设备其它 client / 其它设备）
```

---

## 5. Tool 循环处理（关键 — content 空问题）

**重要**：DeepSeek-V3 等大模型在调 tool 时**默认不输出 content**。客户端必须处理两阶段：

```
stage 1: client → LLM
  → 拿到 { content?, toolCalls? }

stage 2 (only if toolCalls):
  for each toolCall:
    if (toolCall.function.name == "search_memory"):
      result = client → POST /api/tool/memory-recall { assistantId, query: tc.arguments.query, source: tc.arguments.source }
      append { role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) } to messages
  client → LLM (with stage1 assistant message + tool messages)
  → 拿到最终 content

最终 content = stage1.content || stage2.content
```

### UI 占位

stage1 没 content 时，客户端**伪造**一行占位文字（不送 LLM，仅 UI）：

```
"正在查找相关记忆..."
```

stage2 拿到 content 后替换占位。

---

## 6. Etag 缓存策略

`renderedSlots`（5 个静态 slot：role / character / background / constraints / tool_protocol）随
`identity_version` + `profile.updated_at` 变化。客户端：

1. 首次调 `getCharacter` 拿到 etag + 5 个 slot；缓存到本地（per-assistantId）。
2. 每次 `chatContext` 调用带 `haveSlotsETag`。
3. 服务端 etag 一致 → response.renderedSlots = null；客户端用缓存。
4. 服务端 etag 失配 → response.renderedSlots = {...}；客户端更新缓存 + etag。

这能省每次 hot path 的 ~2KB payload。

---

## 7. WS 通道事件（server → client）

| Event | 触发 | 客户端动作 |
|---|---|---|
| `state_changed` | server 推断完 state 后 | 可选：刷新 UI 状态显示 |
| `episode_created` | 新 episode 落库 | 可选：通知用户 |
| `reflection_new` | 新 reflection 落库 | 下次 chatContext 自然带新 narrative |
| `turn_deleted` | 其他端删了 turn | 删本地 row + 刷新视图 |
| `facts_changed` | coreFacts 增删 | 客户端刷新本地 cache |
| `proactive_message` | 主动消息推送 | 显示推送 |

---

## 8. 兼容性

### 旧端点（标 Deprecation）

服务端这些端点仍然工作，但 response header 含 `Deprecation: true`：

| 旧 | 新 |
|---|---|
| `POST /api/character/context` | `POST /api/chat/context` |
| `GET /api/character/bootstrap` | `GET /api/character/{id}` |
| `POST /api/tool/memory-context` | `POST /api/chat/context`（合并） |
| `POST /api/sync/push` | `POST /api/chat/turn`（语义重命名） |

### 已删除

- `POST /api/chat-with-memory` — Phase 2 删除（无客户端调用，server 内部不依赖）

### 客户端迁移建议

**不必立刻全切**。新端点和旧端点并存至少 1 release。建议：
1. 先把 `getCharacter` / `chatContext` 接进 chat path（直接受益于 V_NEW_LEAN slots + 完整 narrative）
2. `chatTurn` 替换 `syncPush` 是无成本的（行为完全一致，只是命名）
3. `deleteChatTurn` 是新增能力（之前没有此端点）—— 视产品需求接

---

## 9. 完整 chat path 伪代码

```kotlin
// (1) boot once per session
val char = api.getCharacter(assistantId)  // 缓存 char.renderedSlots + char.etag

// (2) per turn, before sending user message
val ctx = api.chatContext(ChatContextRequest(
    assistantId = assistantId,
    sessionId = sessionId,
    userInput = userInput,
    haveSlotsETag = cachedEtag
))

// (3) 客户端拼最终 system prompt
val slots = ctx.renderedSlots ?: cachedSlots  // etag 命中就用缓存
val systemPrompt = buildString {
    appendLine(slots.role)
    appendLine()
    appendLine(slots.character)
    appendLine()
    appendLine(slots.background)
    appendLine()
    appendLine(slots.constraints)
    appendLine()
    appendLine(ctx.facts)
    appendLine()
    appendLine(ctx.narrative)
    appendLine()
    appendLine(buildClientSlot())  // <client>{...}</client>
    appendLine()
    appendLine(slots.toolProtocol)
    appendLine()
    appendLine(ctx.assistantPrefill)
}

// (4) call LLM with system + tools
var llmResponse = llm.complete(systemPrompt, messages = [user(userInput)], tools = tools)

// (5) tool loop
while (llmResponse.toolCalls.isNotEmpty()) {
    val toolMessages = llmResponse.toolCalls.map { tc ->
        val result = api.memoryRecall(tc.arguments.query, tc.arguments.source)
        ToolMessage(tc.id, result)
    }
    llmResponse = llm.complete(
        systemPrompt,
        messages = previous + assistant(llmResponse) + toolMessages,
        tools = tools
    )
}

// (6) 显示给用户
displayToUser(llmResponse.content)

// (7) async upload turn
api.chatTurn(ChatTurnRequest(
    deviceId = deviceId,
    turns = listOf(
        SyncTurnDto(uuid7(), assistantId, sessionId, "user", userInput, now),
        SyncTurnDto(uuid7(), assistantId, sessionId, "assistant", llmResponse.content, now2)
    )
))
```
