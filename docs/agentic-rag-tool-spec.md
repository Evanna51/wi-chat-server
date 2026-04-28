# Agentic RAG: search_memory Tool 规格

> 给 app 端 LLM（Claude / Qwen / 任意 tool-calling LLM）的工具定义。
> Server 端只暴露 `POST /api/tool/memory-recall`，不做 decision，不跑 agent loop。

## 设计理念

- **不 chunk**：每条用户消息天然是一个 memory_item，对话场景已是原子粒度
- **app 端持有 tool**：LLM 决定何时调用、用什么 query；server 是哑的搜索后端
- **默认查用户记忆**（source=user）：角色信息大多在 system prompt / 当前上下文里已有，
  只有用户**显式**提到"你"、"你之前"、角色名时才查角色侧

---

## Server 端点

```
POST /api/tool/memory-recall
Content-Type: application/json
Authorization: Bearer <APP_API_KEY>  (如启用)

{
  "assistantId":  "<必填，角色 id>",
  "query":        "<必填，已改写的具体搜索词>",
  "source":       "user" | "character" | "all",   // 默认 "user"
  "category":     "preferences" | "personal_experience" | ... ,  // 可选
  "minQuality":   "A" | "B" | "C" | "D" | "E",                   // 可选，"C" 推荐做安全默认
  "topK":         5,                              // 默认 5，最大 20
  "sessionId":    "..."                           // 可选，命中当前 session 加 0.02 分
}
```

返回：

```json
{
  "ok": true,
  "query": "钢琴",
  "source": "user",
  "count": 2,
  "memories": [
    {
      "id": "019dd...",
      "content": "我每周三晚上学钢琴，已经坚持半年了",
      "memoryType": "user_turn",
      "category": "preferences",
      "quality": "C",
      "createdAt": 1777352000000,
      "score": 0.7821
    }
  ]
}
```

---

## App 端 Tool Schema（OpenAI / Anthropic 通用结构）

```jsonc
{
  "name": "search_memory",
  "description": "Search the user's personal knowledge base, including past conversations, notes, and project records. Use this tool when the user refers to past experiences, previous discussions, or personal context that is not present in the current conversation.\n\nIMPORTANT — `source` parameter:\n- DEFAULT to 'user'. Searches only what the user has previously said (preferences, experiences, plans, etc).\n- Use 'character' ONLY when the user explicitly references the character (mentions '你', '你之前', '上次你说', or the character's name). Most character context is already in the system prompt; do not over-search.\n- Use 'all' rarely, only when the reference is genuinely ambiguous between user and character sides.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "A rewritten, explicit search query optimized for semantic retrieval. Expand vague references like '上次那个事' into concrete terms based on conversation context."
      },
      "source": {
        "type": "string",
        "enum": ["user", "character", "all"],
        "default": "user",
        "description": "Which side of the conversation to search. 'user' = user's own statements/preferences/experiences (default). 'character' = the AI character's life events / past responses (only when user explicitly references character). 'all' = both."
      },
      "category": {
        "type": "string",
        "enum": [
          "chitchat", "personal_experience", "relationship_info", "knowledge",
          "goals_plans", "preferences", "decisions_reflections", "wellbeing", "ideas"
        ],
        "description": "Optional category filter. Only meaningful when source='user'. Use when query has a clear semantic dimension (e.g. user asks about their preferences → 'preferences')."
      },
      "minQuality": {
        "type": "string",
        "enum": ["A", "B", "C", "D", "E"],
        "description": "Minimum quality grade to include (A=best, E=worst). Use 'C' as a safe default to filter out chitchat noise. Omit to include all qualities."
      },
      "topK": {
        "type": "integer",
        "default": 5,
        "description": "Number of memories to return. Default 5, max 20."
      }
    },
    "required": ["query"]
  }
}
```

---

## 调用决策提示（System Prompt 片段）

把这段加到 app 端 system prompt 里，引导 LLM 正确使用 source：

```
## Memory Search Guidance

When the user references past context, use the search_memory tool. Default to source='user'.

Switch source:
- "user" (default)：User mentions their own past — "上次我提到的", "我之前说过", "我习惯", "我打算"
- "character"：User references the character — "你之前说", "你不是说过", "你那个 [角色名]"
- "all"：Genuinely ambiguous, usually 1-2 retries when default failed

Always rewrite vague queries to concrete terms BEFORE calling. E.g.:
- "上次那个事" + context shows we discussed Python → query="Python 学习"
- "她最近怎么样" + context mentions sister → query="妹妹 近况"
```

---

## 端点对比

项目里已存在三个搜索相关端点，区分如下：

| 端点 | 类型 | 用途 |
|------|------|------|
| `/api/admin/search-fts` | FTS 关键词搜索 | ops/调试用，关键词模糊查找 |
| `/api/tool/memory-context` | "智能 RAG"（含 decision） | server 端用，自动判断要不要查 + 返回格式化 prompt 片段 |
| **`/api/tool/memory-recall`** | **纯向量搜索** | **app 端 tool call 直击，无 decision，返回原始 memory 列表** |

agentic 流程下用最后一个。前两个保留以兼容旧调用方。

---

## 调用示例（curl）

```bash
# 默认查用户偏好
curl -X POST http://192.168.5.7:8787/api/tool/memory-recall \
  -H "Content-Type: application/json" \
  -d '{"assistantId":"e2e_test_01","query":"钢琴","minQuality":"C"}'

# 查角色侧（用户提到"你"）
curl -X POST http://192.168.5.7:8787/api/tool/memory-recall \
  -H "Content-Type: application/json" \
  -d '{"assistantId":"e2e_test_01","query":"羽毛球","source":"character"}'

# 限定分类
curl -X POST http://192.168.5.7:8787/api/tool/memory-recall \
  -H "Content-Type: application/json" \
  -d '{"assistantId":"e2e_test_01","query":"工作","source":"user","category":"goals_plans"}'
```
