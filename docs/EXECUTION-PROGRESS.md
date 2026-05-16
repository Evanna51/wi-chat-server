# wi-chat-server 改造执行进度

> 此文档是三阶段改造的"驾驶舱"，每完成一个子任务即时更新。
> Context 满或 session 重启时，从这里继续即可。

---

## 阶段 A: 自动备份

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| A1 | 改 scripts/backup.js：月→日粒度，MAX(created_at,updated_at)，文件名 incr-YYYY-MM-DD，清理 8 天前 | ✅ | 54f880a |
| A2 | 新建 scripts/full-backup.js：VACUUM INTO data/backups/full-YYYY-Www.sqlite，清理 4 周前 | ✅ | a0bd939 |
| A3 | 新建 scripts/restore.js：--from <full> --apply <incr...>，按时间 upsert | ✅ | 47108f5 |
| A4 | src/scheduler.js 加 daily_incr_backup (0 3 * * *) + weekly_full_backup (30 2 * * 0)，带 leader lock | ✅ | 1923601 |
| A5 | .env.example 补 BACKUP_DAILY_CRON / BACKUP_WEEKLY_CRON / 保留窗口配置 | ✅ | f22cc59 |
| A6 | .gitignore 加 data/backups/ | ✅ | f22cc59 |
| A7 | README.md 增加"备份与恢复"小节（带具体命令示例） | ✅ | f22cc59 |
| A8 | 手动跑 full-backup + backup 验证产出（不 commit） | ✅ | — |
| A9 | 更新此文档阶段 A 完成 + commit | ✅ | 本次 |

**涉及文件**

- `scripts/backup.js` — 改造（月→日，MAX time col，自动清理）
- `scripts/full-backup.js` — 新建（VACUUM INTO + 周命名 + 清理）
- `scripts/restore.js` — 新建（全量 + 增量恢复，带安全备份）
- `src/scheduler.js` — 加两个 cron runner + exports
- `src/config.js` — 加 backupDailyCron / backupWeeklyCron 等 6 个配置项
- `.env.example` / `.gitignore` / `README.md` — 配套文档

**关键决策**

- 全量备份目录统一改为 `data/backups/`（复数），与原 `data/backup/`（旧增量）区分
- 增量 `since` 采用固定 `now - 25h`（有 1h 重叠），不依赖状态文件，更易推断
- VACUUM INTO 在 scheduler cron 中运行时使用 writable db 连接
- 全量备份已存在时跳过（幂等），scheduler 重启不会重复写
- `require.main === module` 保护：scripts 被 scheduler require 时不触发 CLI 入口

**验证结果**

- `node scripts/full-backup.js` → `full-2026-W18.sqlite` 276 KB ✓
- `node scripts/backup.js daily` → `incr-2026-04-28.jsonl.gz` 20 B（0 行，数据早于 25h 窗口，正常）✓
- `node scripts/backup.js verify incr-2026-04-28.jsonl.gz` → `{"ok":true}` ✓
- `node -e "require('./src/scheduler')"` → 加载正常，无副作用 ✓

**未决/遗留**: 无

---

## 阶段 B: 角色状态机 MVP

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| B1 | Migration 011：character_state 增列（mood/relationship/energy/focus 共 11 列） | ✅ | 7df9f27 |
| B2 | 新建 src/services/characterStateService.js：读/写/衰减/关系升降/prompt 片段 | ✅ | f9609ca |
| B3 | 触发逻辑接入：report-interaction 后调 onUserMessage 更新状态 | ✅ | a0cc231 |
| B4 | Prompt 注入：catchupService + proactivePlanService 注入 stateFragment | ✅ | a45ca46 |
| B5 | 单测 20 个断言（Suite 1-7，含 7d 沉默衰减、情绪衰减、prompt 片段） | ✅ | 74f3ede |
| B6 | init-character-states.js 脚本（幂等，为已有 assistant 补全状态） | ✅ | 91bbf82 |
| B7 | 更新此文档阶段 B 完成 + commit | ✅ | 本次 |

**涉及文件**

- `src/db/migrations/011_character_mood.sql` — 新增 11 列
- `src/services/characterStateService.js` — 新建（327 行）
- `src/routes/api.js` — report-interaction 接入
- `src/services/catchupService.js` — stateFragment 注入
- `src/services/proactivePlanService.js` — stateFragment 注入
- `scripts/init-character-states.js` — 幂等初始化脚本
- `tests/characterState.test.js` — 20 断言测试

**关键决策**

- Phase 1 采用 heuristic 信号（关键词 + 消息长度），无 LLM 情绪分析调用，避免成本 & 延迟
- 情绪衰减在读取时惰性计算（`getEffectiveState`），无需后台扫描任务
- 沉默检测：2d→lonely，7d+level≥3→疏远，30d→软重置
- prompt 注入作为可选参数（`stateFragment`），不存在则静默跳过，零风险

**验证**

- `node tests/characterState.test.js` → 20 passed, 0 failed ✓
- `node scripts/init-character-states.js --dry-run` → 正常输出 ✓
- `node src/services/catchupService.js` (require 加载) → ok ✓

**未决/遗留**: 无（Phase 2 词库扩展已完成，见下节）

---

## 阶段 B 扩展（Phase 2）：情绪词库扩展

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| E1 | 新建 src/services/emotionTaxonomy.js：27 GoEmotions base + 95 secondary = 122 词 | ✅ | 60ff424 |
| E2 | 重写 characterStateService.js：删 EMOTION_META，接入 resolveEmotion，两段启发式 | ✅ | abeb917 |
| E3 | buildStatePromptFragment 中英对照格式"成就感 / accomplished" | ✅ | abeb917 |
| E4 | 测试：Suite 1-7 全过 + Suite 8-11 新增扩展词库测试，38 passed 0 failed | ✅ | 6bca75c |
| E5 | 端到端验证：PM2 重启 + curl 验证 accomplished/prompt 格式 | ✅ | — |
| E6 | 更新此文档 + commit | ✅ | 本次 |
| bugfix | NEGATIVE_SIGNALS 单字符误匹配修复（"特别"里的"别"） | ✅ | aeae23d |

**涉及文件**

- `src/services/emotionTaxonomy.js` — 新建（122 词，含 group/parent/valence/arousal/intensity_default）
- `src/services/characterStateService.js` — 重构（两段启发式，resolveEmotion 替代 EMOTION_META）
- `tests/characterState.test.js` — 扩展至 38 断言，11 个 Suite

**关键决策**

- 选 GoEmotions 27 作为 base（贴合对话语境，比 Ekman/Plutchik 更现代）
- 两段启发式：第一段粗分（deep_share/positive/negative），第二段关键词细化
- 无 LLM 调用：`成功/做到了→accomplished`、`感谢→thankful`、`哈哈！！→elated`、`孤独→lonely` 等依赖明确关键词，其余降级到同类默认词
- Prompt 注入 "中文 / English" 双标签，增强 LLM 对情绪的理解

**E2E 验证（Phase 2）**

```
POST /api/report-interaction { content: "项目终于成功了！太棒了，做到了！" }
→ mood_emotion=accomplished, valence=0.7 ✓
→ buildStatePromptFragment: "情绪：成就感 / accomplished（强度 40%，偏正面）" ✓
```

**未决/遗留**: 无

---

## 阶段 D：用户记忆分类 + 质量评级 + 引用计数

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| D1 | Migration 013：memory_items 加 6 列（category/confidence/method/grade/cite_count/last_cited_at）+ 2 索引 | ✅ | 7bda723 |
| D2 | memoryClassificationService.js：启发式 + LLM 两段策略，合并 category+quality 一次调用 | ✅ | 7bda723 |
| D3 | api.js report-interaction 写入后 setImmediate 异步触发分类 | ✅ | 1cd3313 |
| D4 | memoryRetrievalService 加 category 过滤 + quality/cite 加权 + 批量自增 cite_count | ✅ | a775a3c |
| D5 | backfill 脚本 + scheduler 每 10 分钟兜底 cron | ✅ | 7bf55ff |
| D6 | 单测 21 断言（Suite 1-7：启发式/persist/skip/idempotent/LLM/backfill/integrity） | ✅ | 4636131 |
| D7 | E2E 验证：启发式路径 + LLM 路径 + provider_call_log 写入 | ✅ | — |
| D8 | 更新此文档 + commit | ✅ | 本次 |

**涉及文件**

- `src/db/migrations/013_memory_category.sql` — 新建（6 列 + 2 索引）
- `src/services/memoryClassificationService.js` — 新建（180 行）
- `src/services/memoryRetrievalService.js` — 改写（加权公式 + 过滤 + 自增）
- `src/routes/api.js` — report-interaction setImmediate 钩子
- `src/scheduler.js` — runMemoryClassifyBackfillTick + 注册 cron
- `src/config.js`, `.env.example` — `MEMORY_CLASSIFY_CRON`
- `scripts/backfill-memory-categories.js` — 新建（脚本 & cron 共用）
- `tests/memoryClassification.test.js` — 21 断言

**关键决策**

- 9 大语义类别 + A-E 质量评级，**合并到单次 LLM JSON 调用**，prompt 仅多 30 tokens，本地 Qwen 成本可忽略
- 启发式优先（覆盖明确情况，零成本），LLM 兜底；启发式失败时短消息(<5字)默认 chitchat D，其余交 LLM
- 异步分类不阻塞 HTTP，配合 cron 兜底防丢
- 仅对 `memory_type='user_turn'` 分类，life_event/work_event 等保持 NULL
- 检索 ranking 公式调整：`semantic 0.42 + recency 0.18 + salience 0.10 + confidence 0.08 + quality 0.10 + cite 0.05 + edge 0.05`，原 0.48/0.20/0.15/0.10 让出权重给新维度
- 检索时批量自增 cite_count 并记 last_cited_at，"被高频检索"成为隐式重要度信号

**E2E 验证**

```
POST /api/report-interaction { content: "我每周三晚上学钢琴，已经坚持半年了" }
→ HTTP 响应 < 5ms（不阻塞）
→ DB: category=preferences, grade=C, method=heuristic, conf=0.7 ✓

POST /api/report-interaction { content: "我家阳台上的薄荷又长出新叶子了" }
→ DB: category=personal_experience, grade=C, method=llm, conf=0.95 ✓
→ provider_call_log: 1 次 LLM 调用，123 in / 18 out tokens, 1.4s ✓
```

**未决/遗留**

- `chat-with-memory` / `tool/memory-context` 等检索入口尚未暴露 `category` 参数；后续可加（属增量优化，不影响核心闭环）
- 现有历史 memory_items 跑一次 backfill 即可全量回填（命令：`node scripts/backfill-memory-categories.js`），或等 cron 自动处理

---

## 阶段 C: LLM Provider 抽象

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| C1 | 建 src/llm/：ILLMProvider JSDoc + index.js 工厂 + QwenProvider.js | ✅ | ca78721 |
| C2 | FakeProvider.js 测试用（setResponse/queueResponse/getCallLog） | ✅ | ebc2f72 |
| C3a | catchupService → getProvider().complete() | ✅ | da41572 |
| C3b | proactivePlanService → getProvider().complete() | ✅ | 6e68190 |
| C3c | proactivePlanService config 引用修复 | ✅ | a519ddb |
| C3d | memoryDecisionService → getProvider().complete() | ✅ | 3ef88bd |
| C3e | lifeMemoryService → getProvider().complete() | ✅ | e68842e |
| C3f | proactiveMessageDecisionService → getProvider().complete() | ✅ | cd948ae |
| C4 | embeddingService → getEmbedProvider().embed() | ✅ | 71a35cf |
| C5 | migration 012 provider_call_log + QwenProvider recordProviderCall | ✅ | 97a4248 |
| C6 | .env.example 加 LLM_PROVIDER / LLM_EMBED_PROVIDER | ✅ | 4e2aa7f |
| C7 | ClaudeProvider.js + OpenAIProvider.js 最小 stub | ✅ | 4e2aa7f |
| C8 | 集成验证：10 模块加载测试全通过 | ✅ | — |
| C9 | 更新此文档阶段 C 完成 + 整体收尾汇总 + commit | ✅ | 本次 |

**涉及文件**

- `src/llm/ILLMProvider.js` — 接口定义（JSDoc typedef + 抽象基类）
- `src/llm/QwenProvider.js` — Qwen 实现（complete + embed fallback + healthCheck + token 估算）
- `src/llm/FakeProvider.js` — 测试用假 provider（可控 response queue）
- `src/llm/ClaudeProvider.js` / `src/llm/OpenAIProvider.js` — 最小 stub
- `src/llm/callLogger.js` — provider 调用日志（惰性建表，兼容旧 DB）
- `src/llm/index.js` — 工厂 + 单例缓存 + 测试注入接口
- `src/db/migrations/012_provider_call_log.sql` — 新表
- `src/services/catchupService.js` — 迁移至 provider
- `src/services/proactivePlanService.js` — 迁移至 provider
- `src/services/memoryDecisionService.js` — 迁移至 provider
- `src/services/lifeMemoryService.js` — 迁移至 provider
- `src/services/proactiveMessageDecisionService.js` — 迁移至 provider
- `src/services/embeddingService.js` — 迁移至 provider（精简至 10 行）
- `src/config.js` — 加 llmProvider / llmEmbedProvider

**关键决策**

- `responseFormat: "json"` 自动将 temperature 强制为 0，避免 JSON 格式错误
- callLogger 惰性建表 + 静默降级：migration 012 未应用时不崩溃
- QwenProvider embed 失败时 fallback 到 `deterministicEmbedding`（sha256 → float 数组），保证向量化链路不中断
- `_setProviderForTesting()` / `_resetProviders()` 供测试 DI，不污染生产单例

**验证**

- 10 模块加载测试全通过（catchup / proactivePlan / memoryDecision / lifeMemory / proactiveMessageDecision / embedding / llm/index / QwenProvider / FakeProvider / callLogger）✓
- PM2 进程 online，内存 86 MB，无异常重启 ✓

**未决/遗留**: 无

---

## 阶段 CC-1: Character Cognition Layer Phase 1（Identity + Relationship Engine）

**状态**: ✅ 已完成
**开始时间**: 2026-05-08
**完成时间**: 2026-05-08
**分支**: `feature/character-system`

> 把"AI 角色"从"带 prompt 的 LLM"演进成"有结构化人格 + 多维关系动力学 + 情绪惯性 + 社交姿态选择"的认知系统。完整 7 层架构图见 [character-cognition-architecture.md](./character-cognition-architecture.md)。

**子任务**

| # | 任务 | 状态 |
|---|------|------|
| T-CC-01 | Migration 025 character_identity（21 字段）+ identityVocab（35 traits / 12 modes / 8 tensions） | ✅ |
| T-CC-02 | Migration 026 relationship_state（12 维 + 6 时间戳）+ relationship_event 流水 | ✅ |
| T-CC-03 | identityService（read + coefficients）+ relationshipDynamicsService（13 类事件 × 12 维 × identity 系数） | ✅ |
| T-CC-04 | Migration 027 emotion inertia（suppressed_emotion / unresolved_topic / mood_trend_24h）+ helpers | ✅ |
| T-CC-05 | onUserMessage 接入 identity 系数 + 事件分类 + dynamics 写入 + suppression patch + EMA | ✅ |
| T-CC-06 | POST /api/character/context 聚合端点（identity + state + emotion + dynamics + socialMode + promptFragment） | ✅ |
| T-CC-07 | identity CRUD（GET/POST + vocab endpoint）+ seed-character-identities 脚本（--all / --from / --dry-run） | ✅ |
| T-CC-08 | identity/dynamics fragment 注入 catchupService + proactivePlanService（buildPlanPrompt / buildNextPushPrompt） | ✅ |
| T-CC-09 | socialModes.js（12 mode + 评分函数 + prompt 模板）+ chooseSocialMode 接入 context builder | ✅ |
| T-CC-10 | characterCognition.test.js（67 断言，8 suites）+ characterState.test.js（38 断言）继续全过 | ✅ |
| T-CC-11 | docs/character-cognition-architecture.md + EXECUTION-PROGRESS Phase CC-1 章节 | ✅ |
| T-CC-12 | seed 脚本 + dynamics 自带 ensureRelationshipState 幂等初始化（无独立 migrate-mood-trend，EMA 起始 0 自然累积） | ✅ |

**新增文件**

- `src/db/migrations/025_character_identity.sql` — 21 字段
- `src/db/migrations/026_relationship_state.sql` — 12 维 + 流水表
- `src/db/migrations/027_emotion_inertia.sql` — character_state 加 5 列
- `src/services/character/identityVocab.js` — 受控词表 + validators
- `src/services/character/identityService.js` — CRUD + ensureDefault + getIdentityCoefficients
- `src/services/character/relationshipDynamicsService.js` — 13 类事件 × 12 维 × identity 系数
- `src/services/character/socialModes.js` — 12 mode 评分 + prompt 模板
- `src/services/character/characterContextBuilder.js` — 7 层 payload 聚合 + promptFragment 拼装
- `scripts/seed-character-identities.js` — --all / --from / --dry-run
- `tests/characterCognition.test.js` — 67 断言

**关键决策**

- **identity 第一公民化**：从 character_background 的裸 TEXT 升级为 21 字段 + JSON 数组 + 受控词表
- **关系 1 维 → 12 维**：与现有 character_state 共存，分工是"实时态 vs 中期累积态 vs 长期态（CC-3）"
- **identity-aware delta**：所有 dynamics delta 过 identity 系数。同样的 cold_response，anxious 角色 abandonment_fear +0.053，secure 仅 +0.020（2.65× 差距）
- **不衰减字段**：unresolved_conflict / resentment 必须由 reconciliation / gratitude_expressed 事件清掉，符合"未化解就一直在那里"
- **emotion inertia**：valence 大反转（≥0.4）+ 旧 intensity ≥0.5 时把旧情绪推进 suppressed（24h 半衰期，比明面 6h 慢 4×）
- **socialMode 是 behavior layer 雏形**：12 个 mode 评分 + top-1（或 top-1+2 联合），identity.socialStrategyDefault 给 +0.3 基线加成
- **token 预算硬约束**：promptFragment ≤ 800 字符（约 512 tokens），超长按 "social mode → dynamics narrative" 顺序砍

**E2E 验证**

```
identity-aware 差异（同样 cold_response，intensity 0.7）：
  anxious + high_sensitivity: abandonment_fear +0.053
  secure  + thick_skinned:    abandonment_fear +0.020   # 2.65× 差距 ✓

emotion inertia：
  frustrated(0.6, valence=-0.55) → accomplished(0.7, valence=+0.7)
  → suppressed='frustrated' intensity=0.36 (= 0.6 × 0.6 retain)
  → mood_trend_24h: -0.165 → 0.095 (EMA α=0.3) ✓

socialMode 4 场景：
  playful_teasing + 高 closeness   → primary=teasing
  avoidant + recent conflict        → primary=defensive, secondary=detached
  anxious + abandonment_fear=0.7    → primary=reassuring
  valence=-0.6 + suppressed=sad     → primary=depressive ✓
```

**测试**

- 105 passed, 0 failed（67 新 + 38 旧）

**未决/遗留**

- 现有 4 个生产 assistant 还没人手 hand-craft identity（用 seed --all 配最小默认即可，业务方面用户可自己通过 admin UI 手填）
- Phase 2-4 蓝图已写在 character-cognition-architecture.md，等用户决定优先级
- 老端点处理：`/character/bootstrap` 已物理删除；`/api/relationship/state` 转 dormant（客户端从 context 响应 fan-out characterState）

---

## 阶段 CC-2: Character Cognition Layer Phase 2（Narrative Memory + Persistent Topic）

**状态**: ✅ 已完成
**开始时间**: 2026-05-08
**完成时间**: 2026-05-08
**分支**: `feature/character-system`

> 把"记忆"从 atomic memory_items 升级到结构化的"故事化叙事 + 长期话题"。让 LLM
> 不只看到一堆零散事实，而是"那段你失恋时" / "钢琴学习初期" 这种故事化上下文。

**子任务**

| # | 任务 | 状态 |
|---|------|------|
| T-CC2-01 | Migration 028: narrative_episode + persistent_topic + episode_memory_link | ✅ |
| T-CC2-02 | episodeBuilder service: LLM clustering + cursor-based 增量构建 + 13 字段 episode + topic 候选识别 | ✅ |
| T-CC2-03 | persistentTopicService: 7 状态机 + alias 启发式匹配 + trajectory 滑窗 + dormant sweep | ✅ |
| T-CC2-04 | onUserMessage 接入：hot path 命中 alias → recordMention（不创建新 topic） | ✅ |
| T-CC2-05 | memoryRetrievalService.includeEpisodes：检索结果附 episode summary | ✅ |
| T-CC2-06 | characterContextBuilder 注入 [最近的重要叙事] + [长期关注的话题]，预算 800 → 1200 | ✅ |
| T-CC2-07 | 6 个新 API endpoint（episodes / topics CRUD + admin build）+ 2 个新 cron | ✅ |
| T-CC2-08 | 45 断言测试套件 + 文档 + commit | ✅ |

**新增文件**

- `src/db/migrations/028_narrative_episode.sql` — 3 张表 + 6 索引
- `src/services/character/persistentTopicService.js` — 13 字段 + 7 状态 + alias 匹配
- `src/services/character/episodeBuilder.js` — LLM clustering + cron + admin 入口
- `tests/narrativeAndTopics.test.js` — 45 断言（7 suites）

**修改文件**

- `src/services/characterStateService.js` — onUserMessage 加 topic mention update
- `src/services/character/characterContextBuilder.js` — 注入叙事/话题段，预算 800→1200，段级丢弃
- `src/services/memoryRetrievalService.js` — includeEpisodes 参数
- `src/routes/api.js` — 6 个新 endpoint
- `src/scheduler.js` + `src/config.js` + `.env.example` — 2 个新 cron

**关键决策**

- **不复用 memory_edges**: episode↔memory 是"概念↔实例"，复用同型 edge 表会模糊语义。新 episode_memory_link 表
- **hot path 只 update 不创建 topic**: 避免每条消息打 LLM。新 topic 由 episodeBuilder cron 用 LLM 识别
- **cursor 不存表**: query "最新 episode.time_range_end" 作为下次起点，免维护额外 KV 行
- **topic alias 至少 2 字符**: 防"不"/"没"等单字误匹配（沿用 Phase 1 review fix 同款经验）
- **episode 至少 2 条 memory**: 单条 memory 不构成"episode"，避免噪音
- **dormant 状态自动转**: 21d 未提自动 dormant；resolved 是终态不参与衰减
- **段排序按砍优先级**: header → identity → state → dynamics → episodes → topics → socialMode（最易重算的最先丢）

**E2E 验证**

```
钢琴 topic mentionCount = 2（创建 1 + onUserMessage hit 1）✓
trajectory 25 次 mention 后 length = 20（滑窗）✓
dormant sweep: 25d-old growing topic → dormant ✓
characterContext payload 含 activeTopics + recentEpisodes ✓
promptFragment 含 [最近的重要叙事] + [长期关注的话题] 段 ✓
低 importance episode (0.3) 不进 fragment ✓
dormant topic 不进 fragment ✓
hot path 不创建新 topic ✓
```

**测试**

- 45 passed, 0 failed (Phase 2)
- 累计 177 passed, 0 failed (Phase 1 + 2)

**未决/遗留**

- episodeBuilder 的 LLM clustering 没有 unit test（mock LLM 太重）—— 留给手动 admin 触发 + 生产观测
- topic 自动状态转换（unresolved/painful/exciting）目前只能由 LLM 在 episodeBuilder 里建议；hot path 不会主动转
- 老 dynamics + memory_retrieval 的 5 次重复 SELECT character_state（Phase 1 review #8）暂未优化

---

## 阶段 CC-3: Character Cognition Layer Phase 3（Relationship Reflection）

**状态**: ✅ 已完成
**开始时间**: 2026-05-08
**完成时间**: 2026-05-08
**分支**: `feature/character-system`

> AI 对当下整体关系的元认知层。不是 retrieval 也不是 narrative —— 是 synthesis：
> "最近你跟 ta 之间在哪个方向" / "ta 现在主要的需要是什么" / "你应该担心 / 抓住的是什么"。

**子任务**

| # | 任务 | 状态 |
|---|------|------|
| T-CC3-01 | Migration 029: relationship_reflection（14 字段，含 emotional_trend / direction / userNeeds / concerns / opportunities / sourceData）| ✅ |
| T-CC3-02 | reflectionService: reflectFor / runReflectionTickWeekly / maybeTriggerEventReflection + LLM synthesis prompt | ✅ |
| T-CC3-03 | onUserMessage 接 maybeTriggerEventReflection（异步, 6h cooldown）+ scheduler weekly cron | ✅ |
| T-CC3-04 | characterContextBuilder 注入 reflection 段（14d 内才算 fresh）+ 段排序：dynamics → reflection → episodes → topics → socialMode | ✅ |
| T-CC3-05 | 3 个新 API endpoint（reflection / reflections / admin reflect）| ✅ |
| T-CC3-06 | 25 断言测试套件（reflection.test.js 4 suites）+ 文档 + commit | ✅ |

**新增/修改**

- `src/db/migrations/029_relationship_reflection.sql`
- `src/services/character/reflectionService.js`（500+ 行：CRUD + 触发判断 + prompt + LLM 调用 + cron）
- `src/services/characterStateService.js` — onUserMessage 加 maybeTriggerEventReflection
- `src/services/character/characterContextBuilder.js` — 注入 reflection 段，预算 1200→1500
- `src/routes/api.js` — 3 个新端点
- `src/scheduler.js` + `src/config.js` + `.env.example` — REFLECTION_WEEKLY_CRON
- `tests/reflection.test.js` — 25 断言

**关键决策**

- **不替换旧 reflection**：累积时间线，新一轮把旧 summary 喂 LLM 做"接续判断"
- **3 类触发**：weekly cron / event-triggered（trust drop / unresolved / silence）/ manual API
- **6h cooldown** for event-triggered 防止短时间反复反思
- **14d freshness** 老反思不进 prompt，防误导
- **避免循环依赖**：reflectionService 不 require characterStateService（hot path 反向依赖），直接 raw `SELECT * FROM character_state`
- **段级丢弃顺序**：dynamics 之后 / episodes 之前注入 reflection（reflection 是 AI 上层视角，比具体 episode 更稳定）

**E2E 验证**

```
trust drop -0.20 in 1h  → trigger='trust_dropped_-0.20_in_1h' ✓
6h cooldown 后再次跌    → null（被 cooldown 拦） ✓
unresolved_conflict 0.6 → trigger='unresolved_conflict_0.60' ✓
silence > 14d           → trigger='silence_16d' ✓
fresh reflection (manual) 注入 promptFragment："[关系反思（manual, 2026/5/8）]..." ✓
stale reflection (15d 前) 不注入 ✓
```

**测试**

- 25 passed, 0 failed (Phase 3)
- 累计 202 passed, 0 failed (Phase 1 + 2 + 3)

**未决/遗留**

- reflectFor 的 LLM 路径无单测（mock 太重）—— 同 episodeBuilder 模式，靠 admin 触发 + 生产观测
- reflection 事件 → behavior 触发（用 reflection.opportunities 自动唤起 ritualistic mode 等）等 Phase 4

---

## 阶段 CC-4: Character Cognition Layer Phase 4（Behavior Planner）

**状态**: ✅ 已完成
**开始时间**: 2026-05-08
**完成时间**: 2026-05-08
**分支**: `feature/character-system`

> Phase 1-3 给了"角色是谁 + 关系怎样 + 过去发生过什么 + AI 怎么理解"。
> Phase 4 把它们综合成"现在该不该发、发什么意图、用什么姿态"——决定真正的行为。

**子任务**

| # | 任务 | 状态 |
|---|------|------|
| T-CC4-01 | behaviorPlanner.js: 14 个 intent + 优先级评分 + identity/dynamics/reflection/topics 综合决策 + buildIntentPromptFragment | ✅ |
| T-CC4-02 | proactivePlanService.scheduleNextPushPlan 接入：intent='none' 早 return（不打 LLM）；其它 intent 注入 prompt | ✅ |
| T-CC4-03 | 2 个新 API endpoint（GET /character/behavior-intent + /vocab）| ✅ |
| T-CC4-04 | 27 断言测试套件（5 suites: 高/中/低优先级 + none/边界 + 优先级竞争）+ 文档 + commit | ✅ |

**新增/修改**

- `src/services/character/behaviorPlanner.js`（370 行：14 intent 定义 + 评分逻辑 + prompt fragment）
- `src/services/proactivePlanService.js` — scheduleNextPushPlan 顶部调 evaluate，'none' 早 return
- `src/routes/api.js` — 2 个新端点
- `tests/behaviorPlanner.test.js` — 27 断言

**14 个 intent**（按优先级排序，详见 [character-cognition-architecture.md](./character-cognition-architecture.md)）：
- 100: reassure_after_conflict
- 95: reassure_abandonment_fear
- 85: pursue_reflection_opportunity
- 80: reciprocate_vulnerable_share
- 75: follow_up_unresolved_topic
- 70: confess_suppressed_feeling
- 60: reciprocate_gratitude
- 55: share_topic_progress
- 50: ritual_check_in / inquisitive_followup
- 45: playful_check_in
- 40: philosophical_invite
- 20: life_check_in（兜底）
- 0: none（用户 30 分钟内活跃 OR 无信号 → 不发）

**关键决策**

- **不打 LLM 决意图**：14 个触发条件都是 deterministic 阈值，启发式快+可解释+可测
- **叠加而非替代** proactivePlan 原有逻辑（cooldown / quiet hours / 冲突取消）全部保留
- **intent='none' 早 return**：节省 LLM 调用 + 避免在不该发时强行生成
- **优先级竞争**：高优先级 intent 触发时低优先级仍打分（appears in `scores`），方便 admin 调试
- **挑 socialMode 双路径**：intent.suggestedMode 优先；为空时 fallback 到 chooseSocialMode

**E2E 验证（每个 intent 至少一个测试）**

```
unresolved_conflict=0.6           → reassure_after_conflict (100) ✓
abandonment_fear=0.7              → reassure_abandonment_fear (95) ✓
reflection.opportunities=[...]    → pursue_reflection_opportunity (85) ✓
last_vulnerable_share=6h ago      → reciprocate_vulnerable_share (80) ✓
suppressed sad intensity=0.5      → confess_suppressed_feeling (70) ✓
unresolved topic 10d 未提         → follow_up_unresolved_topic (75) ✓
growing topic importance=0.6 4d   → share_topic_progress (55) ✓
playful_teasing trait + 高 closeness → playful_check_in (45) ✓
12h silence 无信号                → life_check_in (20) ✓
silenceHours=0.2                  → none ✓
4 个信号同时触发                  → 取最高优先级 100 ✓
```

**测试**

- 27 passed, 0 failed (Phase 4)
- **累计 229 passed, 0 failed (Phase 1-4)**
- Suite breakdown: 94 cognition + 38 state + 45 narrative + 25 reflection + 27 behavior

**未决/遗留**

- intent 对接的 next-push prompt 中 LLM 真实生成质量未做端到端 LLM 测试（成本+并发限制）
- intent='none' 路径目前 silenceHours < 0.5 强制 none；将来可由 quiet hours 配置接管
- behaviorPlanner 当前是 pure synchronous —— 多 assistant 并发评估都是单进程同步顺序，不会拥塞

---

## 7 层架构状态总图（CC-1 ~ CC-4 全部完成）

| 层 | 名称 | 实现位置 | 状态 |
|---|---|---|---|
| 1 | Identity | `character/identityService.js` + `identityVocab.js` + migration 025 | ✅ CC-1 |
| 2 | Relationship Model | `character/relationshipDynamicsService.js` + migration 026 | ✅ CC-1 |
| 3 | Emotion System (含 inertia) | `characterStateService.js` + migration 027 | ✅ CC-1 |
| 4 | Narrative Memory | `character/episodeBuilder.js` + migration 028 | ✅ CC-2 |
| 5 | Topic Persistence | `character/persistentTopicService.js` + migration 028 | ✅ CC-2 |
| 6 | Reflective | `character/reflectionService.js` + migration 029 | ✅ CC-3 |
| 7 | Behavior | `character/behaviorPlanner.js` + `socialModes.js` | ✅ CC-4 |

接入点：[`character/characterContextBuilder.js`](../src/services/character/characterContextBuilder.js) 把 7 层聚合到 `POST /api/character/context` + `promptFragment`（≤1500 字硬约束，段级丢弃）。

---

## 已完成阶段总览

| 阶段 | 描述 | 完成时间 | Commit 数 |
|------|------|---------|-----------|
| A | 自动备份（增量 + 全量 + 恢复 + scheduler 接入） | 2026-04-28 | 5 |
| B | 角色状态机 MVP（migration + service + 触发 + prompt + 测试） | 2026-04-28 | 6 |
| B.2 | 情绪词库扩展（GoEmotions 27+95=122 词，两段启发式，中英 prompt）| 2026-04-28 | 4 |
| C | LLM Provider 抽象（接口 + Qwen + Fake + 5 处迁移 + embedding + call log） | 2026-04-28 | 11 |
| D | 用户记忆分类（migration 013 + 启发式+LLM 两段 + 质量 A-E + cite_count + 检索加权） | 2026-04-28 | 5 |
| CC-1 | Character Cognition Phase 1（identity + 12 维 dynamics + emotion inertia + socialModes + context endpoint）| 2026-05-08 | 1 |
| CC-2 | Character Cognition Phase 2（narrative episodes + persistent topics + cron + retrieval enrichment）| 2026-05-08 | 1 |
| CC-3 | Character Cognition Phase 3（relationship reflection: weekly cron + event-triggered + 14d 注入）| 2026-05-08 | 1 |
| CC-4 | Character Cognition Phase 4（behavior planner: 14 intent + proactive 接入）| 2026-05-08 | 1 |

---

## 前置已完成的 commits（在三阶段开始之前）

| Commit | 标题 |
|--------|------|
| 36db598 | chore: PM2 config + 运行方式文档 |
| 90812bb | docs: 重写项目阅读笔记（基于 main-win） |
| 0988544 | fix(p0): 补 fetch 超时 helper，替换全部裸 fetch 调用 |
| 5da84d6 | fix(p0): SIGTERM/SIGINT 退出等待从 100ms 改为 8s |
| 2ed696c | fix(p0): REQUIRE_API_KEY 默认值改为 0，与 .env.example 对齐 |
| f521496 | chore: 默认关闭 proactiveMessageCron 旧路径 |
| f9c7fb1 | docs: 个人 AI 数据库能力缺口与建设路线图 |
