# wi-chat-server 重构计划

> 基于 `docs/architecture.md` review 出的结构/设计问题，逐项落地。
> **前置约定**：本项目仍在内网阶段、无外部依赖，**不留任何兼容路径**。能删的直接删，不写 shim、不留 deprecated 标记、不维护双跑期。
>
> **配套文档**：
> - [client-release-required.md](./client-release-required.md) — 需要客户端先发版的任务（CR-XX 编号）
> - [known-issues.md](./known-issues.md) — 已知存在但暂不修的问题（KI-XX 编号），含鉴权裸奔 / character_state 写回竞态等

---

## 0. 总原则

1. **反兼容**：删除老表/老字段/老接口直接走 migration drop + 代码删除，不保留 reader/writer fallback。
2. **每个任务一个 PR / 一个 commit 链**：scope 收敛，便于 review 和回滚。
3. **删除前 grep**：每个任务开始前，先 `grep -rn '<symbol>'` 确认引用闭环，避免漏改。
4. **migration 命名延续 022, 023, ...**：保留线性历史；不 squash 已合并的 001-021。
5. **先删后改**：阶段 1（删存量）全部完成后再做阶段 2（结构重构），避免在被删的代码上重构。
6. **鉴权暂不动**：内网环境，shared API key + WS query string 鉴权先保留，等上公网前一次性补齐。

---

## 阶段 1：删除历史包袱（独立任务，无依赖）

> 这一阶段所有任务相互独立，可以并行/任意顺序执行。每个都是「删除 + 单测 + 文档」三件套。

### T-01 删除 `proactive_message_log` 表 ✅

- **动机**：文档 §4.1 明示"保留兼容，新链路不写"；retentionSweeper 也没扫它，纯泄漏。
- **改动**：
  - migration `022_drop_legacy_proactive_log.sql`：`DROP TABLE`
  - `scripts/db-query.js` 同步移除该表 + 顺带把 migration 015 已删的 `local_subscribers` 也清掉（断引用）
- **验收**：migration 已执行，`SELECT name FROM sqlite_master WHERE name='proactive_message_log'` 返回空 ✅

### T-02 删除 `push_token` 表 + FCM 残留 🟡 部分完成

- **动机**：WS 离线兜底已用 `local_outbox_messages`，FCM 链路是死代码。
- **关联**：[CR-01](client-release-required.md#cr-01-移除-fcm-推送注册对应服务端-t-02)
- **完成情况**：
  - ✅ 删 `POST /api/register-push-token`（2026-05-10）
  - ⏳ `DROP TABLE push_token` migration（待跑）
  - ⏳ 删 `src/services/fcm.js` / admin.js FCM 路径 / firebase-admin 依赖 / `FCM_*` env
- **验收**：`grep -rni 'fcm\|push_token\|sendFcmMessage' src/` 为空。

### T-03 删除 `character_state.familiarity` 字段 ✅（2026-05-25）

- **动机**：`intimacyScore + level` 已替代它；`familiarity = floor(totalTurns/3)` 是冗余派生值。
- **关联**：[CR-02](./client-release-required.md#cr-02-不再读-familiarity-字段对应服务端-t-03)
- **改动**：
  - migration 036：`ALTER TABLE character_state DROP COLUMN familiarity`
  - [db.js](../src/db.js) `upsertCharacterState` 去 familiarity
  - `characterStateService.ensureDefaultState` 去 `familiarityHint` 参数
  - `relationshipStateView.js` payload 不再带 familiarity
  - `characterStateUpdater` / `memoryEditService` 不再写 familiarity
  - admin UI（app.js / home / character / character-overview / character-cognition）改用 totalTurns
- **验收**：`grep -rn familiarity src/` 已为空 ✅

### T-04 收紧 `memory_type` 枚举（service 层断言）✅

- **动机**：`tool_call / tool_result / system` 在文档里列为合法值但不写入 memory_items，是认知陷阱。
- **改动**：
  - [db.js](../src/db.js) `insertMemoryItem` 加 `ALLOWED_MEMORY_TYPES` 集合 + 入参校验，非法值直接抛错
  - 默认 `memoryType="turn"` stub 同时清除（之前死参数）
  - 暂未走 schema CHECK：assistant_turn 在 T-08 还要再缩，做一次表 rebuild 即可，避免重复 rebuild
- **验收**：`memoryType='tool_call'` 抛 `invalid memory_type` ✅；user/assistant role 路径 smoke 通过 ✅

### T-05 删除 `RETRIEVAL_STRATEGY` 占位 env ✅

- **修正**：原结论"YAGNI 兜底"不准确——它实际上**被写进 `memory_retrieval_log.strategy` 列做评估标签**，但放错抽象层（应该是代码常量、不是 operator-controlled env）。
- **改动**：
  - [memoryRetrievalService.js:27](../src/services/memoryRetrievalService.js#L27) 新增 `RETRIEVAL_STRATEGY_VERSION = "v1"` 常量，注释说明"改任一权重 → bump 此版本号"
  - 入参 `strategy = config.retrievalStrategy` 删除；写日志时直接用常量
  - [config.js](../src/config.js) 删 `retrievalStrategy` 行
- **验收**：服务正常起；`memory_retrieval_log.strategy` 仍写入 `v1` ✅

### T-06 删除 `scheduler_locks` 表 + service ✅

- **动机**：架构强制 `instances:1, exec_mode:fork`，分布式锁是为不存在的多副本场景准备的。SQLite 单写本身就拦死多副本，锁也救不了。
- **改动**：
  - migration `023_drop_scheduler_locks.sql`：`DROP TABLE scheduler_locks`
  - 删 `src/services/schedulerLockService.js`
  - `scheduler.js` 5 个 tick 函数移除 `tryAcquireSchedulerLock` 调用
  - `routes/browse.js` 健康检查里读锁表的代码移除（`lastRetentionAt` 暂时永远是 null，未来加 retention_log 表恢复）
  - `config.js` 删除 `schedulerLeaderId / schedulerLockTtlMs / *LockName`（5 处）
- **验收**：cron 全部正常注册；`grep scheduler_locks src/` 仅命中 001 / 023 migration ✅

### T-07 修复 `VECTOR_DIM` env 默认值 ✅

- **改动**（方案 B）：
  - [config.js:25](../src/config.js#L25) 默认值 `256 → 1024`，注释说明对应当前 embed 模型
  - [db.js](../src/db.js) 启动时新增 `assertVectorDim()`：从 `memory_vectors.vector_dim` 反查权威值，与 `config.vectorDim` 不一致直接 `process.exit(1)` 并打印明确错误
  - 表为空时跳过断言（首次启动场景）
- **验收**：默认启动 OK ✅；`VECTOR_DIM=512 node ...` fatal 退出 ✅

---

## 阶段 2：结构重构（有依赖，顺序执行）

### T-08 `assistant_turn` 不再写 `memory_items` ✅

- **动机**：assistant_turn 写进 memory_items 后立刻被打 `vector_status='skipped'`、retrieval 又被 `DEFAULT_TYPES` 排除，是纯垃圾行。让它只活在 `conversation_turns`。
- **改动**：
  - [memoryIngestService.js](../src/services/memoryIngestService.js) 新增 `MEMORY_ROLES = {user}`；非 user role 全部 short-circuit 成 logOnly
  - [db.js `ALLOWED_MEMORY_TYPES`](../src/db.js) 删除 `assistant_turn`
  - [memoryRetrievalService SOURCE_TYPES.character](../src/services/memoryRetrievalService.js) 去掉 `assistant_turn`
  - [memoryIndexer.processEvent](../src/workers/memoryIndexer.js) 删 assistant_turn skip 分支
  - [routes/api.js memoryType enum](../src/routes/api.js) 收紧
  - [scripts/db-query.js](../scripts/db-query.js) + [reembed-all.js](../scripts/reembed-all.js) 注释 / WHERE 子句更新
  - 删 `scripts/cleanup-assistant-turn-vectors.js`（一次性脚本，不再需要）
  - migration `024_purge_assistant_turn_memory_items.sql`：DELETE 627 行 assistant_turn + 级联（memory_facts 0 / memory_vectors 1 / memory_edges ~1000 / outbox_events ~627）。conversation_turns 中 role='assistant' 原文保留不动。
  - `proactivePlanService.recordProactiveAsTurn` 不需改：它走 ingestInteraction(role='assistant') 现在自然走 logOnly 分支
- **验收**：
  - migration 跑完 `SELECT COUNT(*) FROM memory_items WHERE memory_type='assistant_turn'` = 0 ✅
  - smoke：role='user' 进 memory_items；role='assistant' 仅写 conversation_turns ✅

### T-09 ingest 副作用拆事件总线 ✅

- **动机**：`ingestTurnsBatch` / WS `message_create` 现在硬编码：cancel plans + character_state 更新 + scheduleNextPushPlan + …。每加一个新副作用都要改 ingest 调用方。
- **改动**：
  - [src/events/turnEvents.js](../src/events/turnEvents.js)：单例 `TurnEventBus extends EventEmitter`，事件名 `turn.user.batch`，payload 含 `{ assistantId, userId, cause, stats: { userTurnCount, lastUserAt, lastUserContent } }`
  - 三个 subscribers（[src/subscribers/](../src/subscribers/)）：
    - `cancelPendingPlans.js` —— sync 调用 `cancelPendingPlansForAssistant`
    - `scheduleNextPush.js` —— `setImmediate` + `scheduleNextPushPlan`（不阻塞 emit 路径）
    - `characterStateUpdater.js` —— ensureDefaultState + upsert + onUserMessage
  - [src/subscribers/index.js](../src/subscribers/index.js) 暴露 `registerAll`，启动时一次性注册
  - [src/index.js](../src/index.js) 启动早期 `require('./subscribers').registerAll()`（必须在 router 接第一条 turn 之前）
  - [routes/sync.js](../src/routes/sync.js) 删 inline cancel/state/schedule 三段，改为 `emitUserBatchEvents()`；同时移除响应里 `cancelledPlans` / `stateUpdated` 字段（debug 计数器，无消费者）
  - [ws/server.js](../src/ws/server.js) message_create 路径同样改 emit
- **保留语义**：emit per (assistant, batch)，匹配现有"每 assistant 一次"的开销，不会因为批里多条 user turn 触发重复 LLM 调用
- **验收**：
  - listenerCount('turn.user.batch') = 3（注册的 subscribers）✅
  - sync push 一条 user turn → 事件被 captured ✅
  - 服务正常启动，所有 require 链通 ✅

### T-10 scheduler 与 ws 解耦

- **动机**：[scheduler.js:230](src/scheduler.js#L230) 直接调 `broadcastToUser`，scheduler 既懂调度又懂网络层。
- **改动**：
  - plan-executor 派发时不直接 broadcast，而是写 `outbox_events(event_type='proactive_dispatch', payload=plan_id)`
  - 新增 `workers/proactiveDispatcher.js`：消费此类事件，在线 → ws broadcast，离线 → enqueueLocalOutboxMessage；标记 plan_sent + recordProactiveAsTurn
  - `scheduler.js` 只负责生成 plan + 标记 due，投递交 dispatcher
- **风险**：中。多了一层异步会引入小延迟（10-100ms 量级，可接受）。需要确认 dispatcher 失败时 plan 状态不会卡死（用 `dispatch_attempts` 计数 + 最大重试）。
- **验收**：plan 在线投递、离线兜底两条路径均通；scheduler 单测可独立跑（不依赖 ws server 拉起）。

### T-11 classify 改事件驱动

- **动机**：当前 classify 是 10min cron backfill，新写入到拿到 category 之间最多 10 分钟空窗，期间 retrieval 用 default 半衰期，分数偏。
- **改动**：
  - `memoryIngestService` 写 outbox `event_type='memory_item.classify'` （和现有 embed 事件同表分 type）
  - `workers/memoryIndexer` 增加 classify handler 分支，或拆独立 `workers/memoryClassifier.js`
  - cron `memory-classify` 改为只跑「漏网兜底」（捞 `created_at < now-1h AND memory_category IS NULL` 的少量行），频率降到 1h
- **风险**：中。新写入瞬间多一倍 LLM 调用压力 —— 注意限速（已有 LM Studio 自然限速）。
- **验收**：sync push 后 30s 内 `SELECT memory_category FROM memory_items WHERE id=?` 已被填充（在 LLM 在线时）。

### T-12 抽 `decisionPipeline` 统一 AI+启发式

- **动机**：classify / plan / decide / catchup / generate 5 处都重复实现「先调 LLM、超时/失败/JSON 错 → fallback heuristic」。
- **改动**：
  - 新建 `src/services/decisionPipeline.js`：
    ```js
    // 输入: { name, ai: () => Promise, heuristic: () => result, schema: zod, timeoutMs }
    // 输出: { result, source: 'ai' | 'heuristic' | 'heuristic_fallback', latencyMs }
    // 副作用: provider_call_log 一处统一写
    ```
  - 5 个 service 改用此 helper
- **风险**：中。需要先把 5 处的 schema 全部 zod 化（部分是 ad-hoc 校验）。
- **验收**：5 个 service 各自代码行数显著下降；`provider_call_log` 出现统一的 `source` 字段。

---

## 阶段 3：可观测性 + 可验证性

### T-13 检索回归 fixture ✅（待跑 baseline）

- **动机**：评分公式 8 个权重 + 7 档半衰期完全靠手调，没有量化验证。
- **改动**：
  - [tests/retrieval/fixtures/](../tests/retrieval/fixtures/) 14 个 fixture，覆盖：
    - 01 单 fact 召回（偏好）／02 关系类（家人）／03 recency vs salience／04 多轮上下文
    - 05 时间窗（withinDays=3）／06 历史检索（>90d 仍命中 floor）
    - 07 知识库 kbName 过滤／08 pin 提升／09 echo 排除（60s 同 session）
    - 10 闲聊空召回（minScore 阈值）／11 source='character' 过滤
    - 12 chitchat 半衰期衰减／13 minQuality 过滤／14 cite_count 巩固
  - [scripts/eval-retrieval.js](../scripts/eval-retrieval.js)：跑分器，输出 per-fixture pass/fail + 平均 Recall@5 + 平均 MRR + 延迟
    - 支持 `--only <name>` / `--write-baseline` / `--compare-baseline --regression-threshold 0.05` / `--keep`
    - fixture 命名空间隔离（`assistant_id` 前缀 `eval-fix-`）；不污染生产
    - 同步 embed（绕过 indexer，确定性）
  - [scripts/reinit-derived-data.js](../scripts/reinit-derived-data.js)：基于现有 `conversation_turns + assistant_profile` 重建所有派生层（memory_items/vectors/facts/edges/outbox/character_state）。配套用法见脚本头注释。
- **运行（手动）**：
  ```
  npm run eval:retrieval -- --write-baseline   # 首次写 baseline
  npm run eval:retrieval -- --compare-baseline # 之后回归对比
  ```
- **后续**：T-08 重构前先跑 baseline；T-08 完成后 `--compare-baseline` 验证不退化。

### T-14 dead_letter_events 巡检 + 重放 ✅

- **动机**：死信只入不出 = 等于没死信表。
- **改动**：
  - [scripts/dead-letter-replay.js](../scripts/dead-letter-replay.js)：list / replay / purge 一站式工具
    - 默认 dry-run，`--apply` 才动数据
    - 支持 `--since 24h|7d|...` / `--id <dead_letter_id>` / `--purge` 多档过滤
  - [scheduler.runDeadLetterMonitorTick](../src/scheduler.js)：daily cron（默认 09:00），扫 24h 内入死信数 > 0 时写 `character_behavior_journal.run_type='dead_letter_alert'` + console.warn
  - `DEAD_LETTER_MONITOR_CRON` env（默认 `0 9 * * *`）+ `npm run dead-letter:replay`
- **验收**：dead-letter dry-run 跑通 ✅；scheduler 加载新 tick 正常 ✅

### T-15 plan-executor 自递归限流 ✅

- **动机**：派发完 next_push 立刻 `scheduleNextPushPlan` 同 assistant，LLM 抽风可能自旋。
- **改动**：[proactivePlanService.scheduleNextPushPlan](../src/services/proactivePlanService.js) 在 cancel 旧 pending 之前加两道闸门：
  - **闸门 1**：`now - last_proactive_at < NEXT_PUSH_MIN_GAP_FROM_LAST_MS` (30min) → skip `min_gap_from_last_proactive`
  - **闸门 2**：24h 滑窗内 `proactive_plans WHERE trigger_reason='next_push' AND status IN ('sent','pending') AND created_at >= now-24h` 的数 ≥ `NEXT_PUSH_24H_MAX_COUNT` (12) → skip `next_push_24h_cap_exceeded`
- 都返回 `{ok: false, skipped: '...'}`，不抛错；调用方该收到的 ack 照常
- **验收**：service 加载通过 ✅；构造模拟数据回归在后续 fixture / 集成测试覆盖

### T-16 character_state 写回竞态防护 → 移至 known-issues

- **决定**：暂不做，已登记进 [known-issues.md KI-02](./known-issues.md#ki-02-character_state-写回-toctou对应-t-16)。
- **触发再做的条件**：
  - 同一 user 多端同时活跃 + 实测出现 mood/intimacy 丢更新
  - 引入新的 `applyMoodEvent` 异步路径
- **方案备忘**：表加 `version` 列，写回 CAS + 失败重试 3 次。预估半天。

---

## 阶段 4：文档同步

### T-17 每个任务 PR 同步改 architecture.md

每个任务的提交里**必须**带上 architecture.md 对应章节修订，避免文档代码漂移。

### T-18 阶段 1+2 全部完成后，做一次 architecture.md 重构

- 删掉所有"保留兼容/已归档/旧字段"残留描述
- §17 migration 演进追加 022-027（视实际编号）
- §15 关键不变量加新增项（如「memory_items 不含 assistant_turn」「无 scheduler_locks」）
- §3 进程组成段去掉分布式锁兜底
- §16 配置表删 `RETRIEVAL_STRATEGY` / `VECTOR_DIM`
- §13 retentionSweeper 表更新（移除已删表的扫描）

---

## 推荐执行顺序（最小风险路径）

```
阶段 1 已完成（2026-05-08）
  ├─ T-05 RETRIEVAL_STRATEGY        ✅
  ├─ T-07 VECTOR_DIM                ✅
  ├─ T-01 proactive_message_log     ✅
  ├─ T-06 scheduler_locks           ✅
  └─ T-04 memory_type 断言          ✅

  待客户端发版（CR-01 对齐后再合）
  ├─ T-02 push_token + FCM          ⏸ 等客户端
  └─ T-03 familiarity               ✅（2026-05-25，migration 036）

阶段 2 已完成（2026-05-08）
  ├─ T-13 retrieval fixture（脚本 + 14 fixture）   ✅（待手动跑 baseline）
  ├─ T-08 assistant_turn 出 memory_items           ✅（migration 024）
  └─ T-09 事件总线                                  ✅（turnEvents + 3 subscribers）

  下一阶段（T-09 落稳后做）
  ├─ T-10 scheduler / ws 解耦      （outbox 事件 + dispatcher worker）
  ├─ T-11 classify 事件驱动        （memoryClassifier worker）
  └─ T-12 decisionPipeline 抽取    （5 处 LLM 调用统一）

阶段 3 已完成（2026-05-08）
  ├─ T-14 dead-letter 巡检 + 重放                  ✅
  ├─ T-15 plan-executor 限流                       ✅
  └─ T-16 → known-issues KI-02（暂不做）           ✅

阶段 4
  T-17 贯穿全过程
  T-18 architecture.md 总修订（这一轮一并做）
```

---

## 跟踪

每个任务在执行时：
1. 拉新分支 `refactor/T-XX-<short-name>`
2. 该任务对应的 architecture.md 修订一并放进 PR
3. PR 描述里勾选本文件对应任务的 checkbox

进度 checkbox（PR merge 后勾上）：

- [x] T-01 删 proactive_message_log
- [ ] T-02 删 push_token + FCM ⏸ CR-01
- [x] T-03 删 familiarity 字段（migration 036）
- [x] T-04 memory_type 断言（service 层）
- [x] T-05 删 RETRIEVAL_STRATEGY
- [x] T-06 删 scheduler_locks
- [x] T-07 修 VECTOR_DIM
- [x] T-08 assistant_turn 出 memory_items（migration 024 + 627 行已清）
- [x] T-09 ingest 事件总线（turnEvents + 3 subscribers）
- [ ] T-10 scheduler / ws 解耦（依赖 T-09 落稳后做）
- [ ] T-11 classify 事件驱动（依赖 T-09 落稳后做）
- [ ] T-12 decisionPipeline 抽取
- [x] T-13 retrieval fixture（脚本 + 14 fixture 已写，待手动跑 baseline）
- [x] T-14 dead-letter 巡检+重放
- [x] T-15 plan-executor 自递归限流
- [x] T-16 → 移至 known-issues KI-02
- [ ] T-17 每 PR 同步文档（持续）
- [ ] T-18 architecture.md 总修订（结合 T-08/T-09/T-14/T-15 这一轮已做）
