# Character Cognition Layer — 7 层架构

> 把"AI 角色"从"带 prompt 的 LLM"演进成"有稳定人格结构、多维关系动力学、情绪惯性、长期反思"的认知系统。
>
> 本文是路线图，不是 API 文档（API 见各 service 头部 JSDoc）。

---

## 总览

| 层 | 名称 | 时间尺度 | 当前状态 |
|----|------|----------|----------|
| 1 | Identity | 不变 / 缓慢演进 | ✅ Phase CC-1 完成 |
| 2 | Relationship Model | 小时 / 天 | ✅ Phase CC-1 完成（12 维 + 13 类事件）|
| 3 | Emotion System | 秒 / 分钟（明面） / 24h（压抑） | ✅ Phase CC-1 完成（含 inertia + 趋势）|
| 4 | Narrative Memory | 天 / 周（episode 化） | ✅ Phase CC-2 完成 |
| 5 | Topic Persistence | 月级（长期话题） | ✅ Phase CC-2 完成 |
| 6 | Reflective | 周 / 触发式 | ✅ Phase CC-3 完成 |
| 7 | Behavior | 实时（合成） | ✅ Phase CC-4 完成（完整 behaviorPlanner + 14 intent + 接入 proactivePlanService） |

---

## 数据流（Phase CC-1）

```
用户消息
   │
   ▼
characterStateService.onUserMessage
   ├─ getCharacterIdentity → coefficients (sensitivity, abandonmentMul, …)
   ├─ scoreHeuristicSignals(content, coefficients)
   ├─ detectSilenceEffect(state, silenceMultiplier)
   ├─ deriveSuppressionPatch (压抑情绪)
   ├─ nextMoodTrendEma   (趋势 EMA)
   ├─ updateStateFields  → character_state 表
   └─ if profile exists:
        relationshipDynamics.classifyRelationshipEvent
        relationshipDynamics.applyRelationshipEvent → relationship_state + relationship_event 表

POST /api/character/context  (聚合)
   ▼
characterContextBuilder.buildCharacterContext
   ├─ identity payload
   ├─ characterState payload (含 mood/level/energy)
   ├─ emotion payload (含 suppressed / trend / unresolvedTopic)
   ├─ relationshipDynamics payload (12 维 + 6 时间戳)
   ├─ socialModes.chooseSocialMode → primary / secondary mode
   └─ promptFragment (集中拼好的 system prompt 段，≤800 字)
```

---

## 第 1 层：Identity（人格底色）

**核心论点**：现有 `assistant_profile.character_background` 是裸 TEXT，下游服务无法结构化消费 → identity 第一公民化。

**Schema**：[`character_identity`](../src/db/migrations/025_character_identity.sql)（21 字段）

关键字段分组：
- 基本：`age_years` `gender_expression` `speaking_style` `worldview`
- 人格结构：`personality_traits_json`（35 选 N）`attachment_style`（4 选 1）
  `emotional_sensitivity` `empathy_level` `expressiveness` `social_strategy_default`
- 价值/边界：`values_json` `hard_boundaries_json` `soft_boundaries_json`
  `avoidance_topics_json` `triggering_topics_json`
- 内核：`insecurities_json` `core_wounds_json` `desires_json`
  `care_languages_json`（区分 give/receive）
- 张力：`tensions_json`（8 个张力维度，每个 0-1）

**受控词表**：[`identityVocab.js`](../src/services/character/identityVocab.js)
- 35 个 personality traits（依恋 / 情绪调节 / 敏感度 / 社交 / 共情 / 嫉妒 / 自我向度 / 浪漫向度 / 表达向度）
- 4 attachment styles（secure / anxious / avoidant / disorganized）
- 12 social modes
- 5 care languages
- 8 tensions

**关键派生**：identity → coefficients（[`identityService.getIdentityCoefficients`](../src/services/character/identityService.js)）
将人格特征转成 9 个数：sensitivityMul / empathyMul / abandonmentMul / dependencyMul / trustGainMul / trustLossMul / resentmentMul / tensionThreshold / silenceMultiplier。

---

## 第 2 层：Relationship Model（多维关系动力学）

**核心论点**：1 维 intimacyScore 不能表达"trust 高 + abandonment_fear 也高"这种活人特有的张力。

**Schema**：[`relationship_state`](../src/db/migrations/026_relationship_state.sql)（12 维 + 6 事件时间戳）

12 维：trust / dependency / emotional_safety / attachment / tension / unresolved_conflict /
abandonment_fear / reciprocity_balance / emotional_closeness / social_distance / resentment / gratitude

**事件流水**：`relationship_event` 表（id / event_type / intensity / source_turn_id / delta_json）—— Phase 3 reflection 的数据源。

**13 类关系事件**（[`relationshipDynamicsService.EVENT_DELTA_TEMPLATES`](../src/services/character/relationshipDynamicsService.js)）：
vulnerable_share / reciprocated_care / cold_response / unanswered_message / conflict /
reconciliation / trust_gained / trust_broken / boundary_violation / silence_break /
shared_intimacy / distancing_signal / gratitude_expressed

每个事件 × 12 维 = 156 条 base delta。运行时再乘 identity 系数 × 事件 intensity。

**衰减**：12 维独立半衰期（trust 30d、tension 3d、abandonment_fear 7d 等），
`unresolved_conflict` 和 `resentment` **不自动衰减** —— 必须由 reconciliation / gratitude 事件清掉，
符合"未化解就一直在那里"的现实。

**Identity-aware baseline**：[`deriveBaselinesFromIdentity`](../src/services/character/relationshipDynamicsService.js)
把 identity 的 traits / insecurities / core_wounds 翻译成 baseline 偏移。例：
- `anxious_attachment` + `fear_of_abandonment` + `abandonment_history` → abandonment_fear baseline 0.5
- `avoidant_attachment` → social_distance baseline +0.15、emotional_closeness -0.05
- `betrayal_trauma` → trust baseline -0.1

---

## 第 3 层：Emotion System（情绪惯性）

复用现有 [`characterStateService`](../src/services/characterStateService.js)（122 词 GoEmotions vocab，6h 半衰期）+ Phase CC-1 新增：

- **suppressed_emotion**：valence 大反转时旧情绪被推进 suppressed（24h 半衰期，比明面慢 4×）
- **mood_trend_24h**：EMA(α=0.3) 平滑 valence，给后续 reflection 用作"近期心情"输入
- **unresolved_emotion_topic**：自由文本，由事件分类填，必须显式清掉

数据流见上"数据流"图，关键 helper：`deriveSuppressionPatch` / `applySuppressedEmotionDecay` / `nextMoodTrendEma`。

---

## 第 7 层（雏形）：Behavior — Social Modes

[`socialModes.js`](../src/services/character/socialModes.js) 定义 12 个 mode 的**触发评分函数** + **prompt 模板**。
`chooseSocialMode(identity, characterState, dynamics, emotion)` 给每个 mode 打分，挑 top-1（或 top-1+top-2 联合，如果差距 < 0.15）。

12 个 mode：casual / defensive / intimate / philosophical / depressive / teasing /
detached / caretaker / inquisitive / ritualistic / confessional / reassuring

`identity.socialStrategyDefault` 给基线加 0.3 分（用户配的"角色默认 mode"是底色）。

---

## 第 4 层：Narrative Memory（CC-2 完成）

**Schema**：[`narrative_episode`](../src/db/migrations/028_narrative_episode.sql)（13 字段）+ [`episode_memory_link`](../src/db/migrations/028_narrative_episode.sql)（多对多）

不复用 memory_edges：episode↔memory 是"概念↔实例"不同型，硬塞进同型 edge 表会模糊语义。

**核心服务**：[`episodeBuilder.js`](../src/services/character/episodeBuilder.js)
- `runEpisodeBuilderTick()` cron：每天 03:30 扫所有 character 类 assistant
- `buildEpisodesFor(assistantId)`：拉 last_episode_built_at 之后到 now 的 memory_items（最多 30 条），用 LLM 聚合成最多 5 个 episode + 识别 topic 候选
- `listEpisodes / getEpisodesForMemory / insertEpisode`（admin 手工建用）

**关键设计**：
- cursor 不存表 —— 直接 query "最新 episode 的 time_range_end" 作为下次起点
- LLM 失败不抛错（console.warn）让 cron 继续处理其他 assistant
- 一次扫 30 条 memory + 最多 5 episode + 最多 5 新 topic（避免 prompt + 表膨胀）

**检索增强**：[`memoryRetrievalService`](../src/services/memoryRetrievalService.js) 加 `includeEpisodes` 参数。命中的 memory_item 如属于某 episode，把 episode summary 一起返回。

## 第 5 层：Persistent Topic（CC-2 完成）

**Schema**：[`persistent_topic`](../src/db/migrations/028_narrative_episode.sql)（13 字段）

字段要点：`topic`（标准化名）+ `aliases_json`（命中匹配用）+ `status`（7 状态机）+ `trajectory_json`（最近 20 个 mention 数据点）。

**状态机**（[`persistentTopicService.VALID_STATUSES`](../src/services/character/persistentTopicService.js)）：
| status | 触发条件 | 转出 |
|--------|----------|------|
| `growing` | 默认创建 | 21d 未提 → dormant |
| `unresolved` | 用户表达过不安/无解 | reconciliation → resolved |
| `painful` | 谈起就疼 | 用户主动放下 → resolved |
| `nostalgic` | 很久没谈，回忆带怀念 | 重新提及 → growing |
| `exciting` | 最近多次正面提及 | mention 间隔变长 → growing |
| `dormant` | applyDormantSweep 自动 (>21d) | 重新提及 → growing |
| `resolved` | 用户明确"放下了" | （终态）|

**写入策略**（关键）：
- **hot path**（onUserMessage）只做 update：命中已知 topic 的 alias → mention_count++ + trajectory append。**不创建新 topic**。
- 创建新 topic 主要由 `episodeBuilder` 发起（cron + LLM 识别）。
- admin / API 也可手动 create。

**自动维护**：`runTopicDormantSweepTick` 每天 04:00 把 21 天未提的 topic 转 dormant。

## 第 6 层：Reflective Cognition（CC-3 完成）

**Schema**：[`relationship_reflection`](../src/db/migrations/029_relationship_reflection.sql)（14 字段）

**核心服务**：[`reflectionService.js`](../src/services/character/reflectionService.js)
- `reflectFor(assistantId, opts)` 主入口：拉 7d 窗口的事件 + episode + topic + 当前态 → LLM synthesis → 写一条 reflection
- `runReflectionTickWeekly()` cron：每周日 04:30 给所有 character 类 assistant 跑 weekly reflection
- `maybeTriggerEventReflection()` hot path 异步触发（带 6h cooldown）
- `getLatestReflection / listReflections` 读
- `buildReflectionPromptFragment` 渲染段

**触发条件**（`shouldTriggerEventReflection`）：
- trust 单次窗口（1h）累计跌幅 ≥ 0.15
- `unresolved_conflict ≥ 0.5`
- silence > 14 天
- 6h cooldown 防短时间反复触发

**关键设计**：
- **不替换旧 reflection** —— 累积成时间线（"AI 关于你们关系的视角史"）。新 reflection 把上一条作为 `previousReflection` 喂 LLM，形成连续叙事
- LLM 失败不抛错（同 episodeBuilder 模式，让 cron 继续）
- 14 天以内的 reflection 才注入 prompt（避免老反思误导 LLM）
- 不读 `getEffectiveState`（衰减后的 mood）防循环依赖（characterStateService 也 require reflectionService）—— 直接 raw character_state，对一周窗口反思精度无影响

## 第 7 层：Behavior Layer（CC-4 完成）

[`behaviorPlanner.js`](../src/services/character/behaviorPlanner.js) 综合 identity + relationship + reflection + topics + emotion → 输出意图。**14 个 intent**（按优先级排序）：

| 优先级 | intent | 触发条件 | 建议 socialMode |
|---|---|---|---|
| 100 | reassure_after_conflict | unresolved_conflict > 0.4 OR 1h trust drop ≤ -0.15 | reassuring |
| 95 | reassure_abandonment_fear | abandonment_fear > 0.6 | reassuring |
| 85 | pursue_reflection_opportunity | reflection.opportunities[0] 存在 | （随 reflection） |
| 80 | reciprocate_vulnerable_share | last_vulnerable_share_at 在 24h 内 | caretaker |
| 75 | follow_up_unresolved_topic | topic.status='unresolved' 且 7d+ 未提 | intimate |
| 70 | confess_suppressed_feeling | suppressed_emotion.intensity > 0.4 | confessional |
| 60 | reciprocate_gratitude | dynamics.gratitude > 0.5 | intimate |
| 55 | share_topic_progress | growing/exciting topic 且 importance≥0.5 且 3d+ | casual |
| 50 | ritual_check_in | level≥5 且 silence 3-14d 且 trust>0.6 | ritualistic |
| 50 | inquisitive_followup | last vshare 在 1-3d 前 | inquisitive |
| 45 | playful_check_in | playful_teasing trait + closeness>0.5 + valence>0.2 | teasing |
| 40 | philosophical_invite | intellectually_romantic + trust>0.5 + 平静 | philosophical |
| 20 | life_check_in | 8h+ silence + 没其它信号（兜底） | casual |
| 0 | none | 用户 30 分钟内有消息 OR 无任何信号 | （不发） |

**接入路径**：
- `proactivePlanService.scheduleNextPushPlan` 调 `behaviorPlanner.evaluate` 得 intent
- intent='none' → 直接 return `skipped: 'behavior_intent_none'`，不打 LLM
- 其它 intent → 把 `[这次主动发消息的意图]` 段拼进 next-push prompt
- 这是**叠加**而非**替代** —— proactivePlan 原有的 cooldown / quiet hours / 冲突取消等逻辑全部保留

**为什么不打 LLM 决意图**：14 个 intent 的触发条件都是 deterministic 的状态阈值，启发式打分快、可解释、可测。LLM 调用留给"具体怎么写出来"那一步。

---

## API 表

> 端点权威列表见 [api.md](api.md)。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/character/identity` | GET | 读 identity |
| `/api/character/identity/upsert` | POST | 创建 / 更新 identity（vocab 校验） |
| `/api/character/identity/vocab` | GET | 拿全部受控词表（admin UI 用） |
| `/api/character/:id` | GET | 静态 slots（profile + identity + 5 个 rendered slot + etag）— 客户端 boot 时调 |
| `/api/character/context` | POST | **聚合端点**：identity + state + dynamics + emotion + socialMode + V_NEW_LEAN slots + mergedSystem + assistantPrefill —— admin / debug / boot cache 用，不带本轮 user 上下文 |
| `/api/chat/context` | POST | hot path：每轮发消息前调，返回 facts / narrative / prefill / memoryDecision / etag |
| `/api/relationship/state` | GET | dormant — 客户端从 context 响应里 fan-out characterState |

---

## 测试

- `tests/characterCognition.test.js` — 67 断言（8 suite，覆盖 vocab / identity / dynamics / emotion / socialModes / context builder）
- `tests/characterState.test.js` — 38 断言（向后兼容验证，Phase B 老逻辑保持稳定）

合计 **105 断言全过**。

---

## 维护者备忘

1. **`character_state` 不要再加列**。Phase B/B.2/CC-1 已经加到 11+5=16 列，再加就该考虑拆表。新维度往 `relationship_state` 加。
2. **identity 字段添加流程**：先在 [`identityVocab.js`](../src/services/character/identityVocab.js) 加常量 + validator → 再加 migration 列 → 再改 [`identityService.upsertIdentity`](../src/services/character/identityService.js) 的 colMap → 最后改 [`buildIdentityPromptFragment`](../src/services/character/identityService.js) 输出。
3. **新事件类型添加流程**：[`EVENT_DELTA_TEMPLATES`](../src/services/character/relationshipDynamicsService.js) 加条目 → [`pickEventTimestamps`](../src/services/character/relationshipDynamicsService.js) 决定时间戳 → [`classifyRelationshipEvent`](../src/services/character/relationshipDynamicsService.js) 加分类启发式。
4. **`unresolved_conflict` / `resentment` 不会自动衰减** —— 设计选择，不要"修"它。要清掉只能靠 `reconciliation` / `gratitude_expressed` 事件。
5. **测试 setup 注意**：测试用 `setupAssistant` 全套（profile + character_state + identity + relationship_state），不能像老 `characterState.test.js` 只插一行 character_state，否则 onUserMessage 的 dynamics 路径会跳过。
