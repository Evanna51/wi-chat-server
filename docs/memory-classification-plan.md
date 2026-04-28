# 用户记忆分类实施方案

> 状态: 待执行 | 2026-04-28

## 目标

给 `memory_items` 中的用户侧记忆（`memory_type = 'user_turn'`）加语义分类标签，
使 catchup / proactivePlan / RAG 检索能按分类过滤，实现"只取用户知识收藏"、
"只看用户近期偏好"等能力。

---

## 分类体系（9 大类）

| id | 中文 | 典型示例 | 检索特点 |
|----|------|---------|---------|
| `chitchat` | 闲聊 | "今天天气不错" | recency 权重低；情感信号为主 |
| `personal_experience` | 个人经历 | "上周去杭州出差了" | 时间地点锚点重要 |
| `relationship_info` | 关系信息 | "我妈很担心我" | person entity 为核心 |
| `knowledge` | 知识收藏 | "你知道 HNSWLIB 吗" | confidence > recency |
| `goals_plans` | 目标与计划 | "今年想减肥 10 公斤" | 需要 status 追踪 |
| `preferences` | 偏好与习惯 | "我不喝咖啡" | salience 高；长效记忆 |
| `decisions_reflections` | 决策与反思 | "最终选了 A 方案" | 低 recency，高 salience |
| `wellbeing` | 健康/情绪信号 | "最近睡眠很差" | 时序敏感 |
| `ideas` | 创意与想法 | "要不然做个总结功能？" | 语义聚类价值高 |

---

## DB 改动（Migration 013）

```sql
-- Migration 013: 用户记忆分类
ALTER TABLE memory_items ADD COLUMN memory_category TEXT;
ALTER TABLE memory_items ADD COLUMN category_confidence REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memory_items ADD COLUMN category_method TEXT;  -- 'heuristic' | 'llm' | 'manual'

CREATE INDEX IF NOT EXISTS idx_memory_items_category
  ON memory_items(assistant_id, memory_category, created_at DESC);
```

**不改 memory_type**：`user_turn` / `life_event` / `work_event` 保留，
`memory_category` 是正交维度（只对 user_turn 填写，life_event 留 NULL）。

---

## 分类逻辑：两段式

### 第一段：启发式（零成本，覆盖 ~60%）

```js
function heuristicCategory(text) {
  if (/上周|上个月|昨天|去年|那次|那时候|小时候/.test(text))
    return ["personal_experience", 0.75];
  if (/我妈|我爸|我男友|我女友|我老板|我同事|我朋友|他说|她说/.test(text))
    return ["relationship_info", 0.75];
  if (/不喜欢|喜欢|讨厌|偏好|习惯|每天|经常|总是|从来不/.test(text))
    return ["preferences", 0.75];
  if (/想做|打算|计划|目标|希望|准备|要去/.test(text))
    return ["goals_plans", 0.70];
  if (/压力|睡眠|失眠|头疼|身体|情绪|难受|心情很差/.test(text))
    return ["wellbeing", 0.75];
  if (/你知道吗|其实|原来|发现|学到|看了篇|资料/.test(text))
    return ["knowledge", 0.65];
  if (/哈哈|好的|嗯|OK|随便|是啊|对对对/.test(text) && text.length < 20)
    return ["chitchat", 0.90];
  return [null, 0];  // 交给 LLM
}
```

### 第二段：LLM 精分（覆盖剩余 ~40%）

**调用时机**：启发式返回 null 时，异步写入后调用（不阻塞 HTTP 响应）

**Prompt 模板**（约 120 tokens）：
```
将以下用户消息分类为一个最匹配的类别，返回 JSON：
{"category": "<id>", "confidence": 0.0~1.0}

类别：chitchat / personal_experience / relationship_info /
      knowledge / goals_plans / preferences /
      decisions_reflections / wellbeing / ideas

消息：「{content}」
```

**调用**：走 `getProvider().complete({ responseFormat: "json", maxTokens: 30, temperature: 0 })`
**写回**：`UPDATE memory_items SET memory_category=?, category_confidence=?, category_method='llm' WHERE id=?`

---

## 集成点

### M1：ingestInteraction（report-interaction 写入时）

```js
// src/services/ingestionService.js（或 ingestInteraction 函数）
// 写入 memory_items 后，立即做启发式，低置信度的异步 LLM 分类
const [cat, conf] = heuristicCategory(content);
if (cat) {
  updateMemoryCategory(memoryItemId, cat, conf, 'heuristic');
} else {
  setImmediate(() => classifyWithLLM(memoryItemId, content).catch(() => {}));
}
```

### M2：retrieveMemory 加 category 过滤

```js
// src/services/memoryRetrievalService.js
async function retrieveMemory({ assistantId, query, topK, category = null }) {
  // ...
  const whereClause = category
    ? `WHERE assistant_id = ? AND id IN (${placeholders}) AND memory_category = ?`
    : `WHERE assistant_id = ? AND id IN (${placeholders})`;
  // ...
}
```

### M3：catchupService prompt 注入分类记忆

```js
// 取近期偏好注入 prompt（可选增强）
const prefMemories = await retrieveMemory({ assistantId, query: "用户偏好习惯", category: "preferences", topK: 3 });
```

### M4：/api/memory/recall 路由增加参数

```js
// GET /api/memory/recall?category=knowledge&q=...
```

---

## 回填历史数据

```js
// scripts/backfill-memory-categories.js
// 遍历所有 memory_category IS NULL AND memory_type='user_turn'
// 启发式 + LLM 分类，批量写入
// 幂等：已有分类的跳过
```

---

## 文件清单

| 文件 | 改动 |
|------|------|
| `src/db/migrations/013_memory_category.sql` | 新建 |
| `src/services/memoryClassificationService.js` | 新建（启发式 + LLM 分类逻辑） |
| `src/services/ingestionService.js` 或 `ingestInteraction` 所在文件 | 写入后调分类 |
| `src/services/memoryRetrievalService.js` | 加 category 过滤参数 |
| `src/routes/api.js` | recall 路由加 category 参数 |
| `scripts/backfill-memory-categories.js` | 新建 |
| `.env.example` | 加 `MEMORY_CLASSIFY_ENABLED=1` 开关 |

---

## 执行顺序

1. Migration 013（新建 SQL）
2. `memoryClassificationService.js`（启发式 + LLM）
3. `ingestInteraction` 接入分类（写入时触发）
4. `memoryRetrievalService` 加过滤
5. `backfill-memory-categories.js`
6. `api.js` 路由 + .env.example
7. 单测：分类准确率 + 检索过滤
8. E2E：发一条消息，看 DB 里 memory_category 被填上
9. 更新 EXECUTION-PROGRESS.md

---

## 风险与注意点

- LLM 分类走 `setImmediate` 异步，不影响 report-interaction 响应延迟
- `getProvider()` 调用会写 `provider_call_log`，可用来统计分类成本
- 首次启动前要先跑 migration，再跑回填脚本
- `chitchat` 类默认 salience 写低一点（0.3），避免它污染检索排名
