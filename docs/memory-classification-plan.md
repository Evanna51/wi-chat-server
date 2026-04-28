# 用户记忆分类 + 质量评级实施方案 v2

> 状态: 待执行 | 2026-04-28 | 替代 v1

## 目标

给 user_turn 类记忆同时打上 **3 类标签**，让 catchup / proactivePlan / RAG 能按维度筛选与加权：

1. **memory_category**：9 大语义类别（chitchat / personal_experience / ...）
2. **quality_grade**：A–E 内容质量评级
3. **cite_count**：被检索/引用次数（行为日志驱动）

可靠性 (`confidence`) 和时效 (`created_at`) 已在表里，无需新增。

---

## v1 缺陷（已在本版修正）

| # | v1 缺陷 | v2 修正 |
|---|---------|---------|
| 1 | 没区分 memory_type，可能误分类 life_event | 仅对 `memory_type='user_turn'` 分类，其余 NULL |
| 2 | setImmediate 失败/进程重启会丢分类 | 配合**定期 backfill cron**（10 分钟扫一次 NULL 行）兜底 |
| 3 | 质量评级未接入排名公式 | 检索排名加 `qualityScore * 0.10` |
| 4 | 未利用 cite_count 做"热门记忆"加权 | 排名加 `citePopularity * 0.05`（log 归一化） |
| 5 | category 和 quality 分两次 LLM 调用浪费成本 | **合并到同一次 JSON 调用**，prompt 仅多 30 tokens |
| 6 | 多次 LLM 调用入口未明 | hook 点固定在 `api.js report-interaction` 事务 commit 后 |

---

## 分类体系（9 类）

| id | 中文 | 启发式关键词 |
|----|------|-------------|
| `chitchat` | 闲聊 | 短消息(<20字) + 嗯/哈/好的/OK/对对 |
| `personal_experience` | 个人经历 | 上周/昨天/那次/小时候/去年 |
| `relationship_info` | 关系信息 | 我妈/我爸/男友/女友/老板/同事 |
| `knowledge` | 知识收藏 | 你知道吗/其实/原来/学到/资料 |
| `goals_plans` | 目标计划 | 想做/打算/计划/目标/准备 |
| `preferences` | 偏好习惯 | 喜欢/不喜欢/讨厌/经常/总是 |
| `decisions_reflections` | 决策反思 | 最终/选了/决定/复盘/反思 |
| `wellbeing` | 健康情绪 | 压力/睡眠/失眠/头疼/心情差 |
| `ideas` | 创意想法 | 要不/灵感/想到/试试 |

## 质量评级（A–E）

| 等级 | 定义 | 示例 |
|------|------|------|
| A | 高信息密度，长效价值 | "我每周三晚上学钢琴" |
| B | 有事件/事实，中等价值 | "今天买了红烧肉" |
| C | 一般闲聊带少量信号 | "今天有点累" |
| D | 噪声但保留节奏 | "嗯嗯"、"好的" |
| E | 无信息可丢弃 | "8"、"?" |

启发式默认值：短消息(<10) → D，长消息(>50) → B，其余 C。LLM 精分覆盖。

---

## DB 改动（Migration 013）

```sql
-- Migration 013: 用户记忆分类 + 质量评级 + 引用计数
ALTER TABLE memory_items ADD COLUMN memory_category    TEXT;
ALTER TABLE memory_items ADD COLUMN category_confidence REAL    NOT NULL DEFAULT 0.0;
ALTER TABLE memory_items ADD COLUMN category_method     TEXT;    -- heuristic | llm | manual
ALTER TABLE memory_items ADD COLUMN quality_grade       TEXT;    -- 'A'..'E'
ALTER TABLE memory_items ADD COLUMN cite_count          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN last_cited_at       INTEGER;

CREATE INDEX IF NOT EXISTS idx_memory_items_category
  ON memory_items(assistant_id, memory_category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_unclassified
  ON memory_items(memory_type, memory_category)
  WHERE memory_category IS NULL;
```

---

## 服务层

### `src/services/memoryClassificationService.js`（新建）

接口：

```js
// 同步：仅启发式，零成本，永远不抛
function classifyHeuristic(content) → { category, quality, confidence } | null

// 异步：组合启发式+LLM，写回 DB；幂等可重复调用
async function classifyAndPersist(memoryId, content) → void
```

**LLM prompt（合并 category + quality）**：

```
将以下用户消息打标，返回严格 JSON：
{"category":"<id>","quality":"A|B|C|D|E","confidence":0.0~1.0}

类别：chitchat/personal_experience/relationship_info/knowledge/
     goals_plans/preferences/decisions_reflections/wellbeing/ideas

质量：A=高信息密度长效  B=明确事件事实  C=一般闲聊  D=噪声  E=无信息

消息：「{content}」
```

走 `getProvider().complete({ responseFormat: "json", maxTokens: 60, temperature: 0 })`。
本地 Qwen 一次约 1–2 秒，成本可忽略。

---

## 集成点

### A. 写入时（`src/routes/api.js` report-interaction）

在 `withTransaction(...)` 提交后、`onUserMessageState` 之前/之后均可：

```js
if (role === "user" && result?.memoryId) {
  setImmediate(() => {
    classifyAndPersist(result.memoryId, content).catch(() => {});
  });
}
```

但 ingestInteraction 现在不返回 result。需要小改 ingestInteraction 让 api.js 拿到 memoryId（其实它已返回 `{ memoryId }`，只是 api.js 没接住）。

### B. 检索时（`src/services/memoryRetrievalService.js`）

**新增 category 过滤参数**：

```js
async function retrieveMemory({ assistantId, query, topK, category = null, ... }) {
  // SQL where 加 (category ? "AND memory_category = ?" : "")
}
```

**新增 quality / cite 加权（更新公式）**：

```js
const QUALITY_WEIGHT = { A: 1.0, B: 0.8, C: 0.6, D: 0.3, E: 0.0 };
const qualityScore = QUALITY_WEIGHT[row.quality_grade] ?? 0.5;
const citePopularity = Math.min(1, Math.log1p(row.cite_count || 0) / Math.log(50));

const finalScore =
  semantic        * 0.42  // ↓ from 0.48
  + recency       * 0.18  // ↓ from 0.20
  + salience      * 0.10  // ↓ from 0.15
  + confidence    * 0.08  // ↓ from 0.10
  + qualityScore  * 0.10  // NEW
  + citePopularity* 0.05  // NEW
  + edgeBoost     * 0.05  // 同
  + sessionBoost  * 0.02; // 同
```

**末尾批量自增 cite_count**：

```js
if (ranked.length > 0) {
  const ids = ranked.map(r => r.id);
  db.prepare(
    `UPDATE memory_items
        SET cite_count = cite_count + 1, last_cited_at = ?
      WHERE id IN (${ids.map(() => "?").join(",")})`
  ).run(now, ...ids);
}
```

### C. 兜底 backfill cron（`src/scheduler.js`）

每 10 分钟扫一遍 `memory_category IS NULL AND memory_type = 'user_turn'`，
分类后写回。环境变量 `MEMORY_CLASSIFY_CRON=*/10 * * * *`，关闭设 `off`。

---

## 文件清单 + 顺序

| 步骤 | 文件 | 操作 |
|------|------|------|
| 1 | `src/db/migrations/013_memory_category.sql` | 新建 |
| 2 | `src/services/memoryClassificationService.js` | 新建 |
| 3 | `src/services/memoryIngestService.js` | 已返回 memoryId，无需改 |
| 4 | `src/routes/api.js` | report-interaction 加 setImmediate 钩子 |
| 5 | `src/services/memoryRetrievalService.js` | 加 category 过滤 + quality/cite 加权 + 自增 |
| 6 | `scripts/backfill-memory-categories.js` | 新建（同时供 cron 复用） |
| 7 | `src/scheduler.js` | 新增 backfill cron |
| 8 | `src/config.js` + `.env.example` | 加 `MEMORY_CLASSIFY_CRON` |
| 9 | `tests/memoryClassification.test.js` | 新建 6+ 断言 |
| 10 | E2E：发消息看 DB 是否分类 | — |
| 11 | `docs/EXECUTION-PROGRESS.md` | 加阶段 D + commit |

---

## 验证标准

- 单测 ≥ 6 项全过：启发式正确分类、LLM fallback、retrieval 过滤、cite_count 累计
- E2E：发"我每周三晚上学钢琴" → category=preferences, quality=A/B
- 检索同一查询，cite_count 自增 1
- backfill 脚本对历史 NULL 数据全部回填

---

## 风险

- 本地 Qwen 偶发 JSON 不严谨 → 用 try-catch + 启发式兜底，不让分类失败影响主流程
- 短期内 chitchat 类会占大头（预计 40%+），适当降低其 salience（启发式分类时 salience 写 0.3）
- LLM 模型升级后 grade 标准可能漂移 → grade 由 prompt 文字定义，不依赖外部模型语义；可在测试集回归

---

## 不做的事

- 不做多标签（top-1 类别即可，避免复杂度）
- 不做向量级别的"知识聚类"（远期）
- 不做用户手动校正分类的 UI（远期，可以走 `category_method='manual'` 字段预留）
