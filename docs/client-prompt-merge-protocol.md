# Client Prompt Merge Protocol (V3)

**Status**: Active · 2026-05-10
**Server endpoints**: `POST /api/chat/context` + `GET /api/character/:id`

---

## 1. 一句话总结

**用 `mergedSystem` 字段直接当 system prompt 喂 LLM。** 客户端只想自己嵌 `<client>` slot（本地时间 / 用户 personalization）时才看 `slots` 字典。

---

## 2. 默认路径（推荐）

```kotlin
val resp = chatServerApi.chatContext(ChatContextRequest(
    assistantId = currentAssistantId,
    sessionId = currentSessionId,
    userInput = userMessage,
    history = recentHistory.takeLast(4),
))

// system prompt = mergedSystem（已含所有 router 决策的 slot），末尾追加客户端独有信息：
val systemPrompt = buildString {
    append(resp.mergedSystem)
    if (clientLocalSlot.isNotEmpty()) { append("\n\n"); append(clientLocalSlot) }
    if (resp.assistantPrefill.isNotEmpty()) { append("\n\n"); append(resp.assistantPrefill) }
}
```

`mergedSystem` 已经按 router 决策包含了**当前轮该有的所有 slot**（role / style / voice_skills / background / constraints / attention_1h / narrative / facts / tool_protocol / avoid）。客户端不需要知道 router 选了什么，直接用就行。

---

## 3. 高级路径：嵌 `<client>` slot

response 里给了三件东西配合用：

| 字段 | 含义 |
|---|---|
| `enabledSlots: string[]` | router 决策本轮要拼的 slot 名字数组，已按 canonical 顺序排好 |
| `slots: { role, style, ... }` | slot 字典，每个值是已经 XML-wrap 好的字符串 `"<tag>...</tag>"` 或 `""` |

`enabledSlots` 是 router 的决策**结果**——客户端不需要硬编码 canonical 顺序，按这个数组 map 即可：

```kotlin
val resp = chatServerApi.chatContext(req)
val clientSlot = "<client>\n本地时间：$now\n用户偏好：$pref\n</client>"

val parts = mutableListOf<String>()
for (name in resp.enabledSlots ?: emptyList()) {
    // 推荐 <client> 插在 constraints 后、attention_1h 前
    if (name == "attention_1h") parts.add(clientSlot)
    resp.slots?.byName(name)?.takeIf { it.isNotEmpty() }?.let { parts.add(it) }
}
// 如果 enabledSlots 不含 attention_1h（router 关掉了），<client> 仍要插在 constraints 之后
if ("attention_1h" !in (resp.enabledSlots ?: emptyList())) {
    val ci = parts.indexOfFirst { it.startsWith("<constraints>") }
    if (ci >= 0) parts.add(ci + 1, clientSlot) else parts.add(clientSlot)
}

val systemPrompt = parts.joinToString("\n\n") +
    if (resp.assistantPrefill.isNullOrEmpty()) "" else "\n\n${resp.assistantPrefill}"
```

### Canonical 顺序

server 内部 canonical 顺序（`enabledSlots` 总是按这个排）：

```
role → style → voice_skills → background → constraints
  → attention_1h → narrative → facts → tool_protocol → avoid
```

`enabledSlots` 例子（不同场景 router 决策不同）：

| 场景 | enabledSlots |
|---|---|
| "在吗"（极简反应） | `["role","style","voice_skills","constraints","attention_1h","avoid"]` |
| "我们的关系是什么"（情绪倾诉）| `["role","style","voice_skills","constraints","attention_1h","narrative","avoid"]` |
| "你以前那个朋友怎么样了"（引用过去）| `["role","style","voice_skills","constraints","attention_1h","facts","tool_protocol","avoid"]` |
| "（点燃一支烟）"（RP）| `["role","style","voice_skills","background","constraints","attention_1h","narrative","avoid"]`（含完整 lore） |

### `<client>` slot 推荐位置

**`constraints` 之后、`attention_1h` 之前**——前面是稳定的角色身份+约束，后面是 server 的现场感，client slot 放中间是"客户端此刻语境"的自然位置。

---

## 4. Tool Calling

Server router 决定本轮 chat LLM 是否能 emit `tool_call`。`availableTools` 是清单：

```kotlin
val tools = buildList {
    if ("search_memory" in resp.availableTools) {
        add(SEARCH_MEMORY_TOOL_SCHEMA)  // 客户端维护的 OpenAI standard schema
    }
}

var llmResp = deepseek.chat(model, messages, tools = tools.takeIf { it.isNotEmpty() })

// tool loop（最多 3 轮）
var loops = 0
while (llmResp.toolCalls.isNotEmpty() && loops < 3) {
    messages.add(Message("assistant", llmResp.content, toolCalls = llmResp.toolCalls))
    for (call in llmResp.toolCalls) {
        val result = when (call.name) {
            "search_memory" -> memoryToolApi.searchMemory(MemoryRecallRequest(
                assistantId = currentAssistantId,
                sessionId = currentSessionId,
                query = call.args["query"] as String,
                source = call.args["source"] as? String ?: "all",
            ))
            else -> error("unknown tool ${call.name}")
        }
        messages.add(Message("tool", formatMemoryResult(result), toolCallId = call.id))
    }
    llmResp = deepseek.chat(model, messages, tools = tools.takeIf { it.isNotEmpty() })
    loops++
}
```

`availableTools` 为空时**不要附 tools schema**——闲聊场景附了反而让 chat LLM 困惑。

---

## 5. Response Schema

### `POST /api/chat/context`

```ts
{
  ok: true;
  assistantId: string;
  sessionId: string | null;

  // ⭐ 主输出
  mergedSystem: string;          // 直接当 system prompt
  assistantPrefill: string;      // V3 默认空字符串

  // router 决策本轮启用哪些 slot（按 canonical 顺序）
  enabledSlots: string[];        // 例：["role","style","voice_skills","constraints","attention_1h","avoid"]

  // slot 字典，每个值已 XML-wrap 好。配合 enabledSlots 用：按数组 map 取出拼接。
  slots: {
    role, style, voice_skills, background, constraints,
    attention_1h, narrative, facts, tool_protocol, avoid
    // 每个值是 "<tag>...</tag>" 字符串或 ""
  };

  // 调 chat LLM 时附哪些 tools schema
  availableTools: string[];

  // ── 以下是 debug / 监控字段，不参与 prompt 拼装 ──
  routerDecision: {
    register, skill_ids, budget, layers,
    server_tools, client_tools, reason, characterIntent
  };
  attention1h: { topics, innerFocus, emotionalTone, turnCount };
  memoryDecision: { shouldRetrieve, ranTools, intent?, source? };

  stateVersion: number;
  ts: number;
}
```

### `GET /api/character/:id`（boot 缓存）

schema 是 chat/context 的子集——只有 `mergedSystem` + `slots` + `etag` + `profile` + `identity`，没有 router/attention/memory 这些 hot-path-only 字段。客户端 boot 时拉一次，离线/网络差时作为 fallback prompt。规则同上：用 `mergedSystem` 直接喂 LLM。

---

## 6. Request Schema

```ts
interface ChatContextRequest {
  assistantId: string;
  sessionId?: string;            // 强烈建议传 — 不传不会触发 RAG
  userInput: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;  // ≤10 轮
  topK?: number;
}
```

---

## 7. 时延

| 阶段 | 时延 | 备注 |
|---|---|---|
| 首轮（attention 未缓存 + router LLM + 可能 RAG）| 5-12s | |
| 后续轮（attention 5min 缓存命中）| 3-6s | |

客户端建议：调用期间显示"思考中"占位；失败 fallback 到 boot-cache mergedSystem。

---

## 8. 调试

```kotlin
Log.d("ChatContext",
    "register=${resp.routerDecision.register} " +
    "skills=${resp.routerDecision.skillIds} " +
    "budget=${resp.routerDecision.budget} " +
    "reason=${resp.routerDecision.reason}")
```

| 现象 | 检查 |
|---|---|
| 输出过长 | `budget` 应该 short？|
| 没用上"角色 voice" | mergedSystem 里 `<voice_skills>` 段是否出现？skill_ids 选了什么？|
| 模型编造细节 | `attention1h.topics` 是不是空？`memoryDecision.ranTools.hits` 是 0？|
| chat LLM 应该查记忆但没 emit tool_call | `availableTools` 是否含 `search_memory`？请求里有没有附 tools schema？|

---

## 9. 历史包袱（已删，2026-05-10）

为避免再混淆，**已经物理删除**的字段：

| 旧字段 | 替代 |
|---|---|
| `chatCtx.facts: String` | `mergedSystem` 已含 `<facts>` slot |
| `chatCtx.narrative: String` | `mergedSystem` 已含 `<narrative>` slot |
| `chatCtx.systemSegments: { head, middle, tail }` | `chatCtx.slots: { role, style, ... }` 按 slot 名字字典 |
| `characterCtx.renderedSlots: { role, character, ... }` | `characterCtx.slots: { ... }` 同 chat/context schema |
| `etag` 缓存逻辑 | 暂未启用 |
| `salientPhrase` 顶层字段 | 合并进 `<narrative>` slot |
| `memoryLines` / `memoryGuidance` | retrieved memories 已直接拼进 `<facts>` slot |

服务端 V_NEW_LEAN 整套 (`composeForChat` / `mergeSlots` / 旧 `render*Slot` / `wrapXmlJson` / `<character>` JSON dump) 也物理删除——只剩 V3 一条路径。

---

## 10. 相关文档

- [docs/api.md](api.md) — 当前 API 全清单
- [docs/register-router-design.md](register-router-design.md) — V3 router 架构设计
- [docs/character-cognition-architecture.md](character-cognition-architecture.md) — 7 层认知态
