# AI Tool 手册：memory-recall + memory-correct

> 给客户端 LLM tool-calling 用的两个端点：
> **search** 用户/角色历史 + **edit** 错误/低质记忆。
> 服务端基础信息见 `README.md` 7.x 节，本文是给 LLM 调用方的精简集成指南。

---

## 0. 共同约定

| 项 | 值 |
|---|---|
| Base URL | `http://<host>:<port>` 默认 `http://192.168.5.7:8787` |
| Auth header | `x-api-key: <APP_API_KEY>`；当 `REQUIRE_API_KEY=0`（开发态默认）时 server 不校验 |
| Content-Type | `application/json` |
| 错误响应 | `{"ok": false, "error": "<reason>"}`，HTTP 400/404/500 |
| 成功响应 | `{"ok": true, ...payload}` |
| `assistantId` | 必填，所有 memory 操作强校验属主，跨角色 → 404 `assistant_mismatch` |

时间字段统一用 **Unix 毫秒**。所有 id（memoryId / turnId / assistantId）都是字符串，UUID v7 格式由 server 生成或客户端 push 时生成。

---

## 1. `POST /api/tool/memory-recall` — 搜索历史

**用途**：客户端 LLM 在生成回复前，决定要查"用户之前提过什么"。**不做 decision**，server 哑执行。

### 1.1 完整参数表

| 字段 | 类型 | 默认 | 用途 |
|------|------|------|------|
| `assistantId` | string | **必填** | 角色 id |
| `query` | string | **必填** | 已改写的搜索词（建议 LLM 把用户原话精炼成主题词） |
| `topK` | int 1-20 | `5` | 返回条数 |
| `source` | enum | `"user"` | `"user"`(用户说过的) / `"character"`(角色 life_event 等) / `"all"` |
| `category` | enum | — | 9 类细分：见下表 |
| `memoryType` | enum | — | 单 memory_type 精细过滤，**优先于 `source`**：`user_turn / assistant_turn / life_event / work_event / tool_call / tool_result / system_event` |
| `minQuality` | A/B/C/D/E | — | 过 minQuality 的不返回（NULL 未分类放行）；A 最严 |
| `minScore` | 0-1 | — | finalScore 阈值，过滤弱相关。**建议默认 0.5+** |
| `withinDays` | int >0 | — | 便捷参数：仅返回 N 天内的记忆 |
| `fromMs` | int | — | 精确时间窗起点（unix ms），优先级高于 `withinDays` |
| `toMs` | int | — | 精确时间窗终点 |
| `excludeIds` | string[] ≤100 | — | 翻页用：排除已经看过的 memory id |
| `sessionId` | string | — | 同 session 内 +0.02 score boost（不强制过滤） |
| `includeFacts` | bool | `false` | 一并返回每条 memory 的 `memory_facts` 行 |

**`category` 9 类**：

| id | 中文 | 触发条件示例 |
|---|---|---|
| `chitchat` | 闲聊 | 嗯、哈、好的、ok 这种短回应 |
| `personal_experience` | 个人经历 | 上周/昨天/那次/小时候 |
| `relationship_info` | 关系信息 | 我妈/男友/同事/朋友 |
| `knowledge` | 知识收藏 | 你知道吗/其实/学到 |
| `goals_plans` | 目标计划 | 想做/打算/计划/目标 |
| `preferences` | 偏好习惯 | 喜欢/不喜欢/讨厌/经常 |
| `decisions_reflections` | 决策反思 | 最终/选了/复盘/反思 |
| `wellbeing` | 身心状态 | 失眠/焦虑/心情差/压力 |
| `ideas` | 灵感想法 | 要不/灵感/搞个/试试 |

### 1.2 响应示例

```json
{
  "ok": true,
  "query": "拿铁",
  "source": "user",
  "count": 2,
  "memories": [
    {
      "id": "019dca12-3b4c-7890-abcd-...",
      "content": "我超喜欢拿铁，每天都喝",
      "memoryType": "user_turn",
      "category": "preferences",
      "quality": "B",
      "createdAt": 1778120000000,
      "score": 0.871,
      "facts": [
        {"key": "preference_like", "value": "拿铁", "confidence": 0.9}
      ]
    }
  ]
}
```

`facts` 字段仅在 `includeFacts=true` 时存在。

### 1.3 OpenAI 风格 tool 定义（可粘到客户端 LLM）

```json
{
  "type": "function",
  "function": {
    "name": "search_memory",
    "description": "搜索用户与角色的历史对话和派生记忆。当用户引用过去的事、提到偏好/计划/关系时调用。query 应为精炼的主题词而非整句用户原话。",
    "parameters": {
      "type": "object",
      "required": ["query"],
      "properties": {
        "query": {"type": "string", "description": "搜索词，精炼后的主题"},
        "topK": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
        "source": {"type": "string", "enum": ["user", "character", "all"], "default": "user"},
        "category": {"type": "string", "enum": ["chitchat","personal_experience","relationship_info","knowledge","goals_plans","preferences","decisions_reflections","wellbeing","ideas"]},
        "memoryType": {"type": "string", "enum": ["user_turn","assistant_turn","life_event","work_event","tool_call","tool_result","system_event"]},
        "minQuality": {"type": "string", "enum": ["A","B","C","D","E"]},
        "minScore": {"type": "number", "minimum": 0, "maximum": 1, "description": "建议 0.5；过滤弱相关"},
        "withinDays": {"type": "integer", "minimum": 1, "description": "近 N 天内"},
        "excludeIds": {"type": "array", "items": {"type": "string"}, "description": "翻页排除"},
        "includeFacts": {"type": "boolean", "default": false}
      }
    }
  }
}
```

`assistantId` 不暴露给 LLM，由客户端在调端点时注入（保护跨角色边界）。

### 1.4 LLM 使用建议（prompt 工程）

- 用户问"我之前喜欢什么咖啡？"→ `{"query":"咖啡偏好","category":"preferences","minScore":0.5}`
- 用户说"上周我们聊到的工作焦虑还好吗？"→ `{"query":"工作焦虑","category":"wellbeing","withinDays":14}`
- 想看完整历史不要 dedup → 不传 category，加大 topK，必要时 `withinDays=30`
- 翻第二页 → 把上次返回的 `id` 集合塞 `excludeIds`

---

## 2. `POST /api/tool/memory-correct` — 修正/删除记忆

**用途**：当 LLM 通过 memory-recall 拿到一批结果后，发现有错误/重复/低质数据，调本接口纠错。所有动作写 `memory_audit_log` 留痕。

### 2.1 6 种 action

| action | 必填字段 | 行为 |
|---|---|---|
| `delete` | `memoryId` | 级联删单条 memory_item + 衍生 facts/edges/vectors + outbox + 源 conversation_turn |
| `delete_batch` | `memoryIds[]` (≤50) | 批量级联删；返回每个 id 的 found/reason |
| `update` | `memoryId`, `newContent` | 就地改 content + 重 embed；**保留** conversation_turn |
| `set_quality` | `memoryId`, `quality` (A-E) | 重打质量等级；标 D/E 等于"软删除"但保留行 |
| `add_fact` | `memoryId`, `factKey`, `factValue`, `factConfidence?` | 给该 memory 加 fact triple；同 key 存在时按 confidence 决定覆盖 |
| `remove_fact` | `memoryId`, `factKey?` | 删 fact；`factKey` 给定则只删该 key，省略则删该 memory 全部 facts |

### 2.2 通用字段（所有 action 共用）

| 字段 | 类型 | 默认 | 用途 |
|---|---|---|---|
| `assistantId` | string | **必填** | 强校验属主 |
| `reason` | string ≤500 | — | 写进审计日志，建议总是带，方便事后追溯 |
| `actor` | string | `"ai"` | 也可传 `"user"` / `"system"` / 自定义 |

### 2.3 各 action 详细

#### 2.3.1 `delete` — 删单条

```json
{
  "assistantId": "...",
  "action": "delete",
  "memoryId": "019dca12-...",
  "reason": "用户后来澄清这是反话"
}
```

**响应**：
```json
{
  "ok": true,
  "action": "delete",
  "memoryId": "019dca12-...",
  "deleted": {
    "turn": 1,
    "memoryItems": 1,
    "facts": 0,
    "edges": 2,
    "vectors": 1,
    "outboxEvents": 1
  }
}
```

#### 2.3.2 `delete_batch` — 批量删（≤50）

```json
{
  "assistantId": "...",
  "action": "delete_batch",
  "memoryIds": ["019dca12-...", "019dca13-...", "019dca14-..."],
  "reason": "用户表示这几条是测试数据"
}
```

**响应**：
```json
{
  "ok": true,
  "action": "delete_batch",
  "totalRequested": 3,
  "totalDeleted": 2,
  "details": [
    {"memoryId": "019dca12-...", "found": true, "reason": null},
    {"memoryId": "019dca13-...", "found": true, "reason": null},
    {"memoryId": "019dca14-...", "found": false, "reason": "memory_not_found"}
  ]
}
```

#### 2.3.3 `update` — 改 content（重 embed，保留对话历史）

```json
{
  "assistantId": "...",
  "action": "update",
  "memoryId": "019dca12-...",
  "newContent": "其实我喜欢的是美式不是拿铁",
  "reason": "用户后来澄清"
}
```

> 只改 `memory_items.content` + `vector_status='pending'`（embedding worker 会自动重 embed）。**不改** `conversation_turns` 原句——历史不可篡改。

#### 2.3.4 `set_quality` — 软删除 / 重打质量

```json
{
  "assistantId": "...",
  "action": "set_quality",
  "memoryId": "019dca12-...",
  "quality": "D",
  "reason": "重复内容，标低不再出现在搜索结果"
}
```

**响应**：
```json
{
  "ok": true,
  "action": "set_quality",
  "memoryId": "...",
  "oldGrade": "C",
  "newGrade": "D"
}
```

> 后续 `memory-recall` 带 `minQuality: "C"` 时这条不会再出现，但行还在数据库里，审计可查。

#### 2.3.5 `add_fact` — 加事实

```json
{
  "assistantId": "...",
  "action": "add_fact",
  "memoryId": "019dca12-...",
  "factKey": "preference_like",
  "factValue": "拿铁",
  "factConfidence": 0.9,
  "reason": "AI 推断的稳定偏好"
}
```

**响应**：
```json
{
  "ok": true,
  "action": "add_fact",
  "memoryId": "...",
  "factKey": "preference_like",
  "replacedExisting": false
}
```

**`factKey` 命名建议**（snake_case，描述维度而非内容）：
- `preference_like` / `preference_dislike`
- `habit_morning` / `habit_evening`
- `relationship_with_mom` / `relationship_with_dad` / `relationship_with_<role>`
- `goal_short_term` / `goal_long_term`
- `skill` / `hobby` / `job` / `location`

`factValue` ≤ 50 字。冲突规则：同 `(memoryId, factKey)` 已存在时，仅当新 confidence > 旧 confidence 才覆盖；否则返回 `existing_higher_confidence` 不写入。

#### 2.3.6 `remove_fact` — 删事实

删某个 key：
```json
{
  "assistantId": "...",
  "action": "remove_fact",
  "memoryId": "019dca12-...",
  "factKey": "preference_like"
}
```

删该 memory 下全部 facts（不传 `factKey`）：
```json
{
  "assistantId": "...",
  "action": "remove_fact",
  "memoryId": "019dca12-..."
}
```

**响应**：
```json
{
  "ok": true,
  "action": "remove_fact",
  "memoryId": "...",
  "factKey": "preference_like",
  "removed": 1
}
```

### 2.4 OpenAI 风格 tool 定义

```json
{
  "type": "function",
  "function": {
    "name": "correct_memory",
    "description": "修正 / 删除 / 标低质 memory。当通过 search_memory 发现错误、矛盾、过时、低质数据时调用。所有动作不可逆（除 update 保留原对话）。请总是附 reason 说明为什么改。",
    "parameters": {
      "type": "object",
      "required": ["action"],
      "properties": {
        "action": {
          "type": "string",
          "enum": ["delete", "delete_batch", "update", "set_quality", "add_fact", "remove_fact"]
        },
        "memoryId": {"type": "string", "description": "单条动作 (delete/update/set_quality/add_fact/remove_fact) 的目标"},
        "memoryIds": {"type": "array", "items": {"type": "string"}, "maxItems": 50, "description": "delete_batch 用"},
        "newContent": {"type": "string", "description": "update 用，新内容"},
        "quality": {"type": "string", "enum": ["A","B","C","D","E"], "description": "set_quality 用"},
        "factKey": {"type": "string", "description": "add_fact / remove_fact 用，snake_case"},
        "factValue": {"type": "string", "description": "add_fact 用，≤50 字"},
        "factConfidence": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.8},
        "reason": {"type": "string", "description": "强烈建议总是带，写进审计日志"}
      }
    }
  }
}
```

`assistantId` 由客户端注入。

### 2.5 错误码表

| HTTP | error 字段 | 含义 |
|---|---|---|
| 400 | `<action>_requires_<field>` | 缺必填字段（如 `update_requires_newContent`） |
| 400 | `existing_higher_confidence` | add_fact 时同 key 已有更高置信度 |
| 400 | `unknown_action` | action 拼错 |
| 400 | `empty_content` | update 的 newContent 全空白 |
| 400 | `invalid_grade` | set_quality 的 quality 非 A-E |
| 404 | `memory_not_found` | memoryId 不存在 |
| 404 | `assistant_mismatch` | memory 不属于该 assistantId |
| 500 | `<exception message>` | 服务端异常 |

---

## 3. 推荐工作流

### 3.1 典型纠错链路

```
用户："我才不喜欢拿铁，我说的是美式"
    ↓
LLM 注意到矛盾
    ↓
1. tool_call: search_memory({"query":"拿铁","category":"preferences","topK":5,"includeFacts":true})
    ↓
2. tool_result: 5 条候选，含 fact "preference_like=拿铁"
    ↓
3. LLM 判断哪条要改
    ↓
4. tool_call: correct_memory({"action":"update","memoryId":"019dca...","newContent":"用户实际偏好美式咖啡，不是拿铁","reason":"用户原话纠错"})
    ↓
5. tool_call: correct_memory({"action":"remove_fact","memoryId":"019dca...","factKey":"preference_like"})
    ↓
6. tool_call: correct_memory({"action":"add_fact","memoryId":"019dca...","factKey":"preference_like","factValue":"美式","factConfidence":0.95,"reason":"用户原话纠错"})
    ↓
7. LLM 回复用户："好，记下了，你喜欢美式不是拿铁"
```

### 3.2 软删除低质数据

```
LLM 浏览近期记忆
    ↓
search_memory({"query":"测试","minScore":0.6,"topK":10})
    ↓
发现 3 条都是 "嗯" / "哈" 之类噪音
    ↓
correct_memory({
  "action":"delete_batch",
  "memoryIds":[...],
  "reason":"明显噪音对话"
})
```

或者更保守的"软删除"：

```
correct_memory({"action":"set_quality","memoryId":"...","quality":"E","reason":"无信息量"})
```

### 3.3 加 fact 让以后检索更精准

LLM 看到 `"我妈妈是医生，每天值夜班"` 这样的 user_turn 自动分类为 relationship_info，但事实没抽出来：

```
correct_memory({"action":"add_fact","memoryId":"...","factKey":"relationship_with_mom","factValue":"医生，常值夜班","factConfidence":0.9})
```

下次问"我妈做什么的"，server 端 LLM 就能命中这条 fact。

---

## 4. 审计追溯

所有编辑都写 `memory_audit_log`：

```sql
SELECT action, actor, reason, datetime(created_at/1000,'unixepoch','+8 hours') AS t
FROM memory_audit_log
WHERE assistant_id = '<aid>'
ORDER BY created_at DESC
LIMIT 50;
```

字段：
- `action`: `delete_turn / delete_memory / update_content / set_quality / add_fact / remove_fact`
- `actor`: `ai / user / system / 自定义`
- `payload_json`: 动作前后 diff（如 `{"oldContent":...,"newContent":...}`、`{"oldGrade":"C","newGrade":"D"}`）

---

## 5. 边界 / 注意事项

1. **删除是不可逆的**（除 update / set_quality）—— 删 memory 会同时删源 conversation_turn 和所有 facts/vectors/edges。如果不想丢历史用 `set_quality` 软删。
2. **批量删上限 50** —— 防止 AI 一次性误删。要删更多请分多次。
3. **跨角色防护**：所有 memory 操作都强校验 `assistantId`。即使 LLM 拿到别的 assistant 的 memoryId 也无法操作。
4. **content 修改不会触发 facts 重抽**——AI 改了 content 后，旧 facts 可能与新内容不一致，需要 LLM 显式 add/remove 修正 facts。
5. **add_fact 的 confidence**：低于现有 fact 的 confidence 会被拒绝（防 LLM 反复降级）。如果确实想覆盖，先 `remove_fact` 再 `add_fact`。
6. **vector_status 重 embed 是异步的**——update 后立刻再 search 可能命中不到新 content（embedding worker 几秒内处理）。

---

## 6. 完整 cURL 示例

```bash
API="http://192.168.5.7:8787"
KEY="dev-local-key"
AID="869e5840-73a3-4c30-9451-0cbc56aa8b9a"

# 1. recall
curl -sS -X POST "$API/api/tool/memory-recall" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"assistantId\":\"$AID\",\"query\":\"拿铁\",\"category\":\"preferences\",\"withinDays\":30,\"minScore\":0.5,\"topK\":5,\"includeFacts\":true}"

# 2. add_fact
curl -sS -X POST "$API/api/tool/memory-correct" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"assistantId\":\"$AID\",\"action\":\"add_fact\",\"memoryId\":\"<MID>\",\"factKey\":\"preference_like\",\"factValue\":\"拿铁\",\"factConfidence\":0.9,\"reason\":\"用户原话\"}"

# 3. delete_batch
curl -sS -X POST "$API/api/tool/memory-correct" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"assistantId\":\"$AID\",\"action\":\"delete_batch\",\"memoryIds\":[\"<MID1>\",\"<MID2>\"],\"reason\":\"测试垃圾\"}"

# 4. set_quality 软删除
curl -sS -X POST "$API/api/tool/memory-correct" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"assistantId\":\"$AID\",\"action\":\"set_quality\",\"memoryId\":\"<MID>\",\"quality\":\"D\",\"reason\":\"低质\"}"
```

---

最后更新：2026-05-07（PR-11）
对应实现：`src/routes/api.js` `/tool/memory-recall` + `/tool/memory-correct` + `src/services/memoryRetrievalService.js` + `src/services/memoryEditService.js` + migration 017
