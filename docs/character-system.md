# Character System — API & 运维手册

> 7 层认知架构的**接入层**：API、配置、cron、运维剧本、扩展指南。
> 设计与心智模型见 [character-cognition-architecture.md](./character-cognition-architecture.md)。
> 各 service 的字段细节看头部 JSDoc，本文不重复。

---

## 1. 一图速览

```
              ┌─────────────────────────────────────┐
 client ─────►│ POST /api/character/context         │  入口端点：聚合 7 层 + promptFragment
              └────────┬────────────────────────────┘
                       │ buildCharacterContext()
                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │ identity ── characterState ── emotion ── dynamics ──    │
   │ socialMode ── activeTopics ── recentEpisodes ──         │
   │ latestReflection ── promptFragment(≤1500 chars)         │
   └─────────────────────────────────────────────────────────┘
                       ▲                       ▲
                       │                       │
   user turn (hot path)│                       │ background (cron / event-triggered)
                       │                       │
   characterStateService.onUserMessage          ├─ episodeBuilder cron (03:30)
     ├─ identity coefficients                   ├─ topicDormantSweep cron (04:00)
     ├─ heuristic + suppression + EMA           ├─ reflection weekly cron (Sun 04:30)
     ├─ relationshipDynamics (12 维事件)        └─ reflection event-triggered (6h cd)
     ├─ persistentTopic.recordMention
     └─ maybeTriggerEventReflection (async)

   proactivePlanService.scheduleNextPushPlan
     └─ behaviorPlanner.evaluate → 14 intent → prompt fragment
```

---

## 2. API 端点

所有端点共享 `x-api-key` 鉴权（见 README §0）。`assistantId` 必填字符串。

### 2.1 聚合 — 客户端主用

#### `POST /api/character/context`

**请求**
```json
{ "assistantId": "asst-xxx", "includePromptFragment": true }
```

**响应**（删节）
```json
{
  "ok": true,
  "assistantId": "asst-xxx",
  "ts": 1746700800000,
  "identity": {
    "characterName": "...", "speakingStyle": "...",
    "personalityTraits": ["anxious_attachment", "high_sensitivity", ...],
    "attachmentStyle": "anxious",
    "emotionalSensitivity": 0.8, "empathyLevel": 0.7, "expressiveness": 0.6,
    "values": [...], "hardBoundaries": [...], "softBoundaries": [...],
    "insecurities": [...], "coreWounds": [...], "desires": [...],
    "careLanguages": { "give": [...], "receive": [...] },
    "tensions": { ... }
  },
  "characterState": { "mood": {...}, "relationship": {...}, "energy": 0.7, ... },
  "emotion": {
    "primary": "calm", "valence": 0.1, "arousal": 0.2, "intensity": 0.3,
    "suppressed": { "emotion": "frustrated", "intensity": 0.36 } | null,
    "moodTrend24h": -0.05,
    "unresolvedTopic": null
  },
  "relationshipDynamics": {
    "trust": 0.5, "dependency": 0.3, "emotionalSafety": 0.6,
    "attachment": 0.4, "tension": 0.1, "unresolvedConflict": 0.0,
    "abandonmentFear": 0.5, "reciprocityBalance": 0.0,
    "emotionalCloseness": 0.4, "socialDistance": 0.2,
    "resentment": 0.0, "gratitude": 0.1,
    "lastVulnerableShareAt": ..., "lastConflictAt": null, ...
  },
  "socialMode": { "primary": "reassuring", "secondary": "intimate", "scores": {...} },
  "activeTopics": [{ "id":"...", "topic":"母亲关系", "status":"unresolved", ... }],
  "recentEpisodes": [{ "id":"...", "title":"...", "summary":"...", "emotionalTone":"...", "importance":0.7 }],
  "latestReflection": { "summary":"...", "emotionalTrend":"...", "concerns":[...], "opportunities":[...] } | null,
  "promptFragment": "[角色身份]\n...\n[关系反思（weekly, 2026/5/7）]\n..."
}
```

**400** assistantId 缺；**404** assistant_profile 不存在。

> 这是**主要入口**。客户端把 `promptFragment` 直接拼进 system prompt 即可，不需要再去拼装 7 层结构。结构化字段保留给需要 fine-grained 控制的 client。

### 2.2 Identity（人格底色）

| 端点 | 用途 |
|------|------|
| `GET /api/character/identity?assistantId=` | 读 identity（不存在返回 `identity: null`，不会 404）|
| `POST /api/character/identity/upsert` | 创建/更新（部分字段也可）|
| `GET /api/character/identity/vocab` | 拉所有受控词表（trait / mode / care_language / tension / boundary / attachment_style）|

**upsert 校验规则**：所有 enum 字段过 `identityVocab.validate*`，非法值 → 400。`hardBoundaries` 数组每条必须 ≥2 字符（防"不"/"没"等单字误匹配）。

**典型 body**（最小集）
```json
{
  "assistantId": "asst-xxx",
  "personalityTraits": ["anxious_attachment", "high_sensitivity"],
  "attachmentStyle": "anxious",
  "emotionalSensitivity": 0.8,
  "socialStrategyDefault": "caretaker",
  "hardBoundaries": ["不要谈我的家事", "不接受被嘲笑外貌"],
  "tensions": { "vulnerability_vs_control": 0.6, "closeness_vs_distance": 0.7 }
}
```

### 2.3 Narrative Episodes

| 端点 | 用途 |
|------|------|
| `GET /api/character/episodes?assistantId=&limit=&minImportance=` | 列表（按 time_range_end DESC）|
| `GET /api/character/episodes/:id` | 详情（含 memory link）|
| `POST /api/admin/character/build-episodes` | **手动触发** LLM 聚合（admin / 测试用）|

build-episodes 是 `episodeBuilder` cron 的同步触发版本，body `{ assistantId }`，返回构建产物。

### 2.4 Persistent Topics

| 端点 | 用途 |
|------|------|
| `GET /api/character/topics?assistantId=&status=&limit=&includeInactive=` | 列表（默认排除 dormant/resolved）|
| `POST /api/character/topics/upsert` | 手动创建（hot path 不创建新 topic）|
| `POST /api/character/topics/:id/status` | 7 状态机转换 |
| `POST /api/character/topics/:id/importance` | 调 importance（0-1）|

7 状态：`growing / unresolved / painful / nostalgic / exciting / dormant / resolved`。

### 2.5 Reflection（关系反思）

| 端点 | 用途 |
|------|------|
| `GET /api/character/reflection?assistantId=` | 最新一条 |
| `GET /api/character/reflections?assistantId=&type=&limit=` | 时间线 |
| `POST /api/admin/character/reflect` | 手动触发 LLM 反思 |

`type ∈ weekly / event_triggered / manual`。

### 2.6 Behavior Intent（debug / admin）

| 端点 | 用途 |
|------|------|
| `GET /api/character/behavior-intent?assistantId=` | 当前推荐 intent（含 scores 全表）|
| `GET /api/character/behavior-intent/vocab` | 14 个 intent 定义（priority / triggers / suggestedMode）|

**注意**：生产路径不需要客户端调这个。它由 `proactivePlanService` 内部消费决定 next-push 的意图。这两个端点纯供调试/可视化用。

### 2.7 兼容老端点

| 端点 | 状态 |
|------|------|
| `GET /api/relationship/state` | 保留 1 release 兼容窗口，下个 release 删 |
| `GET /api/character/bootstrap` | 同上 |

新客户端用 `/api/character/context`。`relationshipState` 字段在 context payload 里以 `characterState` 字段名返回（schema 一致）。

---

## 3. 配置项

### 3.1 cron

| Env | 默认 | 触发什么 |
|-----|------|---------|
| `EPISODE_BUILDER_CRON` | `30 3 * * *` | 每天 03:30 — `runEpisodeBuilderTick` 扫所有 character 类 assistant，LLM 聚合 memory_items → episodes |
| `TOPIC_DORMANT_SWEEP_CRON` | `0 4 * * *` | 每天 04:00 — `runTopicDormantSweepTick` 把 21d 未提的 topic 转 dormant |
| `REFLECTION_WEEKLY_CRON` | `30 4 * * 0` | 每周日 04:30 — `runReflectionTickWeekly` 给所有 character 类 assistant 跑 weekly reflection |

> 时间错峰：03:00 backup → 03:30 episode → 04:00 dormant sweep → 04:30 weekly reflection。
> 调整时保持顺序（episode 必须在 reflection 之前，因为 reflection 输入要看 episodes）。

### 3.2 关键阈值（hardcoded in service）

| 位置 | 值 | 含义 |
|------|---|------|
| `characterContextBuilder.MAX_FRAGMENT_LEN_CHARS` | 1500 | promptFragment 总长上限（约 750 tokens） |
| `characterContextBuilder.RECENT_EPISODES_DAYS` | 30 | 注入 fragment 的 episode 时间窗 |
| `characterContextBuilder.RECENT_EPISODES_MIN_IMPORTANCE` | 0.5 | 低于此 importance 的 episode 不进 fragment |
| `characterContextBuilder.REFLECTION_FRESHNESS_DAYS` | 14 | 老于此值的 reflection 不进 fragment |
| `persistentTopicService.DORMANT_THRESHOLD_MS` | 21d | dormant sweep 阈值 |
| `persistentTopicService.TRAJECTORY_MAX_POINTS` | 20 | mention 滑窗长度 |
| `episodeBuilder.MAX_MEMORIES_PER_RUN` / `MAX_EPISODES` / `MAX_NEW_TOPICS` | 30 / 5 / 5 | 单次 cron 处理上限（防 prompt 膨胀） |
| `reflectionService.TRIGGER_TRUST_DROP` | 0.15 | 1h trust 跌幅触发反思 |
| `reflectionService.TRIGGER_UNRESOLVED_CONFLICT_THRESHOLD` | 0.5 | unresolved_conflict 触发阈值 |
| `reflectionService.TRIGGER_SILENCE_DAYS` | 14 | 沉默触发 |
| `reflectionService.TRIGGER_COOLDOWN_MS` | 6h | event-triggered 反思冷却 |

需要调阈值时直接改常量 + commit；无 env override（设计上：阈值是认知层的"性格"，不应该 per-deploy 变）。

---

## 4. 数据库 schema

| Migration | 表 | 说明 |
|-----------|----|------|
| `025_character_identity.sql` | `character_identity` | 21 字段 + JSON arrays 存 traits/values/boundaries/insecurities/care/tensions |
| `026_relationship_state.sql` | `relationship_state` (12 维 + 6 时间戳) + `relationship_event` (流水) | 多维关系动力学 |
| `027_emotion_inertia.sql` | `character_state` 加 5 列 | suppressed_emotion / unresolved_topic / mood_trend_24h |
| `028_narrative_episode.sql` | `narrative_episode` + `episode_memory_link` + `persistent_topic` | 故事化叙事 + 长期话题 |
| `029_relationship_reflection.sql` | `relationship_reflection` | 周 / 触发式 / 手动反思 |

> `character_state` 不再加列。Phase B/B.2/CC-1 已 11+5=16 列；新维度往 `relationship_state` 加。

---

## 5. 运维剧本

### 5.1 给已有 assistant 配 identity

最小默认（推荐先跑这条做基线，再人手细调）：

```bash
node scripts/seed-character-identities.js --all --dry-run    # 预览
node scripts/seed-character-identities.js --all              # 实际写入
```

参数：
- `--all` — 默认只覆盖 `assistant_type='character'` 的 assistant
- `--include-untyped` — 把 type 为空的也算上
- `--from <path.json>` — 从 JSON 文件批量导入（schema 见脚本 head）
- `--dry-run` — 不写入

特定 assistant 手工配：直接 `POST /api/character/identity/upsert`。

### 5.2 检查 cron 是否在跑

```bash
# 看最近一次 episode 构建
node scripts/db-query.js --table narrative_episode --limit 5 --order "created_at DESC"

# 看最近一次 reflection
node scripts/db-query.js --table relationship_reflection --limit 5 --order "created_at DESC"

# scheduler 加载是否正常
node -e "require('./src/scheduler')"   # 无副作用，只验 require 链
```

### 5.3 手动触发（调试用）

```bash
# 给特定 assistant 立刻构建 episodes
curl -X POST http://127.0.0.1:8787/api/admin/character/build-episodes \
  -H 'Content-Type: application/json' -H 'x-api-key: dev-local-key' \
  -d '{"assistantId":"asst-xxx"}'

# 立刻反思
curl -X POST http://127.0.0.1:8787/api/admin/character/reflect \
  -H 'Content-Type: application/json' -H 'x-api-key: dev-local-key' \
  -d '{"assistantId":"asst-xxx","reflectionType":"manual","triggerReason":"debug"}'

# 看当前会发什么 intent（如果不是 none）
curl 'http://127.0.0.1:8787/api/character/behavior-intent?assistantId=asst-xxx' \
  -H 'x-api-key: dev-local-key' | jq
```

### 5.4 排查"为什么 AI 主动消息没发"

按 behaviorPlanner 的早 return 顺序排查：

1. `GET /api/character/behavior-intent?assistantId=` — 如果 `intent='none'` 看 `contentHint`
   - "刚说过话" → 用户 30min 内有消息（设计行为）
   - "无任何信号" → 14 个 intent 都没触发，需要等积累
2. 如果 intent 不是 none 但仍未发：
   - 看 `proactive_plans` 表 `cancelled_reason` 列
   - 看 `proactivePlanService.scheduleNextPushPlan` 的 24h 12 条上限 / 30min 间隔（T-15）是不是触发
3. 看 `provider_call_log` 表是否有 LLM 调用失败记录

### 5.5 排查"为什么 reflection 没生成"

```bash
# 看是否有触发记录（reflection_type='event_triggered'）
node scripts/db-query.js --table relationship_reflection --assistant <id> --limit 20

# weekly cron 看是否注册
grep -n "REFLECTION_WEEKLY_CRON\|runReflectionTickWeekly" src/scheduler.js
```

可能原因：
- 6h cooldown 内已触发过 → 看 `created_at` 间隔
- LLM 调用失败 → service 设计不抛错（cron 继续），看 `provider_call_log` 错误
- weekly cron 卡时区 → `SCHEDULER_TIMEZONE=Asia/Shanghai`

---

## 6. 扩展指南

### 6.1 加新的 personality trait

1. `src/services/character/identityVocab.js` 加进 `PERSONALITY_TRAITS`
2. 改 `identityService.getIdentityCoefficients` —— 决定该 trait 对 9 个系数的贡献
3. （可选）`relationshipDynamicsService.deriveBaselinesFromIdentity` 加 baseline 偏移
4. 测试：在 `tests/characterCognition.test.js` 的 vocab suite 加断言

### 6.2 加新的 relationship event 类型

1. `relationshipDynamicsService.EVENT_DELTA_TEMPLATES` 加 entry（12 维 base delta）
2. `pickEventTimestamps` — 决定该事件更新哪些时间戳
3. `classifyRelationshipEvent` — 加分类启发式（关键词模式）
4. **测试**：单字符模式必死。pattern 至少 2 字符 + 上下文锚定（"我忙" ≠ "帮忙"）

### 6.3 加新的 social mode

1. `socialModes.js` 加 entry to `MODE_PROMPTS` + `MODE_SCORERS`
2. **避免被支配**：评分函数最大值 ≥ 0.5（trait 默认加成 0.3 是个隐藏阈值，太低会一直输给其它 mode）
3. 加测试场景

### 6.4 加新的 behavior intent

1. `behaviorPlanner.INTENT_DEFINITIONS` 加 entry（priority / urgency / suggestedMode）
2. `evaluate` 函数加 score 计算分支
3. **优先级 collision**：每个 intent 的 priority 必须独一无二（决策时按 max 取）
4. 加测试到 `tests/behaviorPlanner.test.js`

### 6.5 新的 reflection 触发条件

1. `reflectionService.shouldTriggerEventReflection` 加判断分支
2. 阈值用大写常量（`TRIGGER_*`），便于以后调
3. **6h cooldown 是全局的**，不区分触发原因 —— 想加细粒度 cooldown 时改 `TRIGGER_COOLDOWN_MS` 拆成 map

---

## 7. 已知陷阱

| 陷阱 | 症状 | 怎么避 |
|------|------|--------|
| ASCII 双引号嵌进 JS 双引号字符串 | parser 报错 | 内层用 `「...」` Chinese brackets（CC-1 review 期间踩过 4 次） |
| 单字符正则模式 | 误匹配 ("帮忙" 命中 `忙` pattern) | pattern ≥2 字 + 上下文锚定（`我忙\|很忙\|太忙`） |
| 循环依赖 | "Accessing non-existent property of module exports inside circular dependency" warning | reflectionService 不 require characterStateService（hot path），改 raw `SELECT * FROM character_state` |
| 事务边界 | dynamics 写入种竞态 | `applyRelationshipEvent` 把 SELECT + UPDATE + INSERT 全包在单 transaction |
| 段级 truncate vs char-slice | char-slice 砍掉半个 emoji / CJK | promptFragment 用段级 pop，不用 `slice(0, N)` |
| seed 误覆盖 | `--all` 默认只 character 类 | 写过 default `assistant_type IN ('','character')` 会污染 writer/general，已改回 `'character'`，需要旧行为加 `--include-untyped` |

---

## 8. 测试

5 个 suite，共 229 断言。

```bash
node tests/characterCognition.test.js     # 94 断言（vocab + identity + dynamics + emotion + socialModes + context）
node tests/characterState.test.js         # 38 断言（向后兼容）
node tests/narrativeAndTopics.test.js     # 45 断言（episode + topic）
node tests/reflection.test.js             # 25 断言（trigger / freshness / 时间线）
node tests/behaviorPlanner.test.js        # 27 断言（14 intent + 优先级竞争）
```

LLM 实路径（episodeBuilder / reflectionService）无 unit test，靠 admin 触发 + 生产观测 + provider_call_log 监控。

---

## 9. 相关文件速查

| 模块 | 文件 |
|------|------|
| 入口聚合 | [src/services/character/characterContextBuilder.js](../src/services/character/characterContextBuilder.js) |
| 第 1 层 Identity | [identityVocab.js](../src/services/character/identityVocab.js) · [identityService.js](../src/services/character/identityService.js) |
| 第 2 层 Relationship | [relationshipDynamicsService.js](../src/services/character/relationshipDynamicsService.js) |
| 第 3 层 Emotion | [characterStateService.js](../src/services/characterStateService.js) · [emotionTaxonomy.js](../src/services/emotionTaxonomy.js) |
| 第 4 层 Narrative | [episodeBuilder.js](../src/services/character/episodeBuilder.js) |
| 第 5 层 Topic | [persistentTopicService.js](../src/services/character/persistentTopicService.js) |
| 第 6 层 Reflection | [reflectionService.js](../src/services/character/reflectionService.js) |
| 第 7 层 Behavior | [behaviorPlanner.js](../src/services/character/behaviorPlanner.js) · [socialModes.js](../src/services/character/socialModes.js) |
| API 路由 | [src/routes/api.js](../src/routes/api.js) — 关键字 `character/` |
| Scheduler | [src/scheduler.js](../src/scheduler.js) — 关键字 `runEpisodeBuilderTick` / `runTopicDormantSweepTick` / `runReflectionTickWeekly` |
| Seed 脚本 | [scripts/seed-character-identities.js](../scripts/seed-character-identities.js) |
