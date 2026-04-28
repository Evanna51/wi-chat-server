# wi-chat-server 项目阅读笔记

> 基于 `main-win` 分支（commit `627fdc1`），记录于 2026-04-28。

---

## 1. 项目定位

一个部署在家用机器（Windows/WSL2/macOS）上的 **AI 角色伴侣后端**。核心能力：

- **持久记忆**：每条对话轮次写入 SQLite，异步向量化后可语义检索。
- **自主生活记忆（Phase A）**：角色在用户不在线期间自动生成"日记事件"，重连时提供上下文。
- **主动推送计划（Phase B）**：LLM 预生成带具体引子的主动消息 plan，按触发条件定时投放。
- **实时 WebSocket 推送（Phase C）**：在线时直推，断线时落 `local_outbox_messages` 兜底。
- **离线批量同步（Sync）**：Android 断网缓存的对话通过 `POST /api/sync/push` 批量幂等写入。
- **可视化管理面板（Phase D）**：`/api/browse/*` 路由 + `public/` 静态资源，无需额外部署。

---

## 2. 目录结构

```
src/
  index.js                    # 入口：express + http server + WebSocket
  config.js                   # 全量环境变量读取（dotenv）
  scheduler.js                # 所有 cron 任务 + plan 执行器循环
  db.js                       # SQLite 初始化 + 全部 DB 读写函数
  db/
    migrator.js               # 按序执行 migrations/
    migrations/               # 001-010 共 10 条迁移
  routes/
    api.js                    # 主业务路由（report-interaction、memory-context 等）
    admin.js                  # 运维路由（metrics、indexer、dead-letter）
    browse.js                 # Phase D 可视化路由（GET/PATCH /api/browse/*）
    sync.js                   # 离线同步路由（POST /api/sync/push、GET /api/sync/state）
  services/
    catchupService.js         # Phase A：lazy 生活记忆生成
    proactivePlanService.js   # Phase B：plan 生成 + 触发器评估
    memoryDecisionService.js  # AI 决策是否需要检索记忆
    memoryRetrievalService.js # 向量检索 + 多因子评分
    memoryIngestService.js    # 单条对话 → memory_items + outbox_events
    syncIngestService.js      # 批量幂等写入（Sync）
    characterEngine.js        # 时间段/安静时段/触发条件判断
    lifeMemoryService.js      # 生活记忆 LLM 生成（旧 cron 路径，现已 off）
    proactiveMessageDecisionService.js  # 旧主动消息决策（现已被 Phase B 替代）
    embeddingService.js       # 调用本地 embedding 接口
    langchainQwenService.js   # LangChain Qwen 封装（generateWithMemory）
    fcm.js                    # Firebase FCM 推送
    schedulerLockService.js   # SQLite 级别的调度器互斥锁
    textDedupService.js       # Jaccard 相似度 + 黑名单短语过滤
    vectorStore.js            # 向量存储门面（sqlite / hnswlib 切换）
    vectorProviders/
      sqliteVectorStore.js    # BLOB 列存储向量，余弦相似度暴力搜索
      hnswSidecarStore.js     # HTTP 调用 hnsw-sidecar（:9011）
  workers/
    memoryIndexer.js          # outbox 消费 → 向量化并写入 vector store
    retentionSweeper.js       # 定期清理过期 retrieval_log / outbox / journal
  ws/
    server.js                 # WebSocket 握手 + 帧处理
    connections.js            # socket 注册表 + 心跳探活
scripts/
  setup.js                    # 初始化 .env + data/
  hnsw-sidecar.js             # HNSW 向量旁路进程（可选）
  eval-memory.js              # 检索评估
  db-query.js                 # CLI 快速查库
  run-autonomous-task.js      # 手动跑 cron 任务
  run-catchup.js              # 手动跑 catchup
  run-plan-generator.js       # 手动跑 plan 生成
  migrate-vectors-to-blob.js  # 向量迁移脚本
  sync-replay.js              # 离线同步端到端测试脚本
  ws-test-client.js           # WS 连接测试客户端
  backup.js                   # 月度备份脚本
public/                       # Phase D 静态前端（角色列表 / 管理面板）
docs/                         # 设计文档（offline-sync-plan.md 等）
```

---

## 3. 数据库 Schema（迁移时间线）

| 编号 | 主要变更 |
|------|----------|
| 001 | `memory_items`、`outbox_events`、`memory_edges`、`dead_letter_events`、`memory_retrieval_log` |
| 002 | `memory_items` 加 `vector_blob` + `vector_status`（BLOB 列存向量） |
| 003 | `character_state`、`push_token`、`proactive_message_log`、`autonomous_run_log` |
| 004 | `assistant_profile`（`allow_auto_life`、`allow_proactive_message`）、`memory_facts` |
| 005 | `local_subscribers`、`local_outbox_messages`（本地拉取兜底） |
| 006 | **DROP** `interaction_log`；`autonomous_run_log` **RENAME** → `character_behavior_journal`；补索引 |
| 007 | `memory_items` 增 `vector_blob` 列（第一次 BLOB 迁移） |
| 008 | 清理旧 vector 列，统一到 BLOB 方案 |
| 009 | **FTS5**：`conversation_turns_fts`、`memory_items_fts`（trigram tokenizer） |
| 010 | `proactive_plans`（id/assistant_id/user_id/trigger_reason/intent/draft_title/draft_body/anchor_topic/scheduled_at/status） |

**关键表一览（当前）**

| 表 | 用途 |
|----|------|
| `conversation_turns` | 所有对话轮次（UUID v7，幂等写入） |
| `memory_items` | 向量化记忆单元（salience/confidence/vector_blob） |
| `memory_facts` | 结构化 KV 事实（confidence 驱动） |
| `memory_edges` | 记忆图 edges（供 edgeBoost 评分） |
| `outbox_events` | 写后发布的事件队列（memoryIndexer 消费） |
| `dead_letter_events` | 超重试上限的事件 |
| `memory_retrieval_log` | 检索日志（供 retentionSweeper 清理） |
| `character_state` | 每角色实时状态（familiarity/last_proactive_at） |
| `assistant_profile` | 角色配置（character_background/allow_auto_life/last_session_id） |
| `local_subscribers` | 注册了本地拉取的 userId |
| `local_outbox_messages` | 本地拉取兜底队列 |
| `character_behavior_journal` | 所有自主任务运行记录（life/proactive/plan/catchup） |
| `proactive_message_log` | 旧 FCM 推送记录（legacy） |
| `proactive_plans` | Phase B plan 预生成表 |
| `push_token` | FCM token |

> **注意**：`interaction_log` 已在 migration 006 DROP，任何引用它的旧代码均会在运行时报错。

---

## 4. 核心数据流

### 4.1 实时对话写入（在线路径）

```
POST /api/report-interaction
  → memoryIngestService.ingestInteraction()
    → db.insertConversationTurn()          # 写 conversation_turns
    → db.insertMemoryItem()                # 写 memory_items (vector_status='pending')
    → db.insertOutboxEvent()               # 写 outbox_events
  → db.upsertCharacterState()
```

### 4.2 离线批量写入（Sync 路径）

```
POST /api/sync/push
  → routes/sync.js（zod 校验）
  → syncIngestService.ingestTurnsBatch()
    → 单事务，每条 try/catch，同 id → skipped，时间戳异常 → clock_corrected
    → ingestInteraction() per turn（与在线路径相同）
  → 返回 { accepted, skipped, rejected, details }
```

### 4.3 记忆向量化（后台路径）

```
memoryIndexer（setInterval 2s，idle 时退到 30s）
  → fetchPendingEvents()
  → embedText(memory_items.content)       # 调本地 embedding 接口
  → vectorStore.upsert()                  # sqlite BLOB 或 hnswlib sidecar
  → markDone() / markRetry() / markDead()
  → 超重试上限写 dead_letter_events
```

### 4.4 记忆检索评分

```
retrieveMemory({ assistantId, query, topK })
  → embedText(query)
  → vectorStore.search(queryVector, topK * 2)
  → 每条记忆计算最终分：
      finalScore = semantic×0.48 + recency×0.20 + salience×0.15
                 + confidence×0.10 + edgeBoost×0.05 + sessionBoost×0.02
  → 写 memory_retrieval_log
  → 返回 top-K
```

`recency` 基于 `RETRIEVAL_WINDOW_DAYS`（默认 30 天）线性衰减；`edgeBoost` 来自 `memory_edges` 加权度。

---

## 5. 自主任务系统（scheduler.js）

scheduler 启动 4 个 cron + 1 个 setInterval 执行器：

| 任务 | 默认 cron | 说明 |
|------|-----------|------|
| `legacy-fcm-proactive` | `off` | 旧 FCM 直推，保留供回滚/调试 |
| `life-memory` | `off` | 旧生活记忆 cron，已被 Phase A lazy catchup 替代 |
| `proactive-message` | `*/10 * * * *` | 旧主动消息决策，已被 Phase B plan 替代；仍运行但建议关闭 |
| `plan-generation` | `0 6 * * *` | Phase B：每天 6 点预生成 plan |
| `retention-sweep` | `30 3 * * *` | 清理 retrieval_log/outbox/journal 旧记录 |
| plan-executor | `每 60s setInterval` | 检查 `proactive_plans.scheduled_at <= now`，WS 在线直推否则落 outbox |

**调度器互斥锁**：`schedulerLockService` 用 SQLite WAL 实现，保证单 fork 进程内不重入。

**活跃度分级**（`resolveMessageCheckIntervalMs`）：
- 7 天内有互动 → 每小时检查一次
- 7–30 天无互动 → 每 24h 检查一次
- 30 天以上无互动 → 每 7 天检查一次

---

## 6. Phase A：Lazy 生活记忆（catchupService）

触发方：客户端在开始对话前调 `POST /api/character/catchup`，传入 `lastInteractionAt`。

流程：
1. 验证 gap ≥ 1 小时（否则返回 `generated: 0`）。
2. 按比例推算事件数：`nEvents = clamp(gap / 90min, 1, 8)`。
3. 构建 prompt（角色档案 + 最近 6 条对话 + 最近 12 条 life/work 记忆 + 30 条 facts）。
4. 调用本地 LLM，最多两次（温度 0.8 → 0.95），每次带内部重试一次。
5. 事件通过 Jaccard 去重（阈值 0.5）+ 通用摘要检测（`isGenericSummary`）过滤。
6. 通过的事件按 `absMs`（从 HH:MM 还原到窗口内时间戳）写入 `memory_items`，`created_at` 覆盖为 `absMs`。
7. 每条插 `outbox_events` 触发向量化。

**P0 注意**：`callLlmForCatchup` 使用裸 `fetch()`，无超时。

---

## 7. Phase B：主动推送计划（proactivePlanService）

**触发器**（当前实现 2 个）：
- `inactive_7d`：用户超 7 天无互动 → scheduled_at = now + 2h（绕开安静时段）
- `daily_greeting`：今日尚未联系 + 当前时刻 < 09:00 → scheduled_at = 今日 09:00

**Plan 生成质量控制**：
- 要求 LLM 输出包含 `anchorTopic`（具体引子，3-12 字）
- 黑名单短语（"最近怎么样"、"在干嘛" 等 10+ 条）命中则重试
- Jaccard > 0.4（与近 10 条历史草稿对比）则重试
- 同 `anchorTopic` 7 天内已用过则重试
- 最多两次 LLM 调用（temperature 0.75 → 0.85）

**Plan 执行**（每 60s）：
- 查 `proactive_plans WHERE status='pending' AND scheduled_at <= now`
- 有活跃 WS 连接 → `broadcastToUser()` 直推，`markPlanSent()`
- 无 WS → 落 `local_outbox_messages`，`markPlanSent()`

**P0 注意**：`callLlmForPlanDraft` 使用裸 `fetch()`，无超时。

---

## 8. Phase C：WebSocket 推送通道（ws/）

握手地址：`ws://<host>:<port>/api/ws?apiKey=<key>&userId=<userId>`

`ws/server.js` 流程：
1. HTTP upgrade 劫持（`noServer: true`），校验 apiKey + userId。
2. 握手成功 → 发 `hello` 帧 → flush `local_outbox_messages` 积压（`queued_batch`）。
3. 接收帧：`ping` → `pong`；`ack` → 更新 `local_outbox_messages.status=acked`；`subscribe` → 重新 flush；`presence` → 记录客户端当前界面状态。

`ws/connections.js` 维护 `Map<userId, Set<ws>>`：
- `register(userId, ws)` / `unregister(userId, ws)`
- `broadcastToUser(userId, frame)` → 返回实际发出帧数
- `getActiveSocketCount(userId)` → plan executor 用于判断是否直推
- 心跳：RFC 6455 ping 帧每 25s，超时未收到 pong → `terminate()`

---

## 9. Sync API（routes/sync.js + syncIngestService.js）

### POST /api/sync/push

- zod 校验：`turns[1..200]`，每条需 `id`（UUID v7）、`assistantId`、`sessionId`、`role`、`content`、`createdAt`。
- 时间戳 sanity check：`< 2020-01-01` 或 `> now+1d` → 矫正为 `Date.now()`，result 带 `clock_corrected`，仍算 accepted。
- 同 id 重复 → `skipped: already_exists`（幂等）。
- 单事务，单条失败不回滚整批。

### GET /api/sync/state

返回 `assistantTurnCount`、`totalTurnCount`、`lastTurnAt`，供 Android 自检本地缓存与 server 是否一致。

---

## 10. 配置关键项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | 8787 | 监听端口 |
| `HOST` | 127.0.0.1 | 监听地址（LAN 访问改 0.0.0.0） |
| `REQUIRE_API_KEY` | **"1"** | **⚠️ 默认开启鉴权**，`.env.example` 写的是 0 |
| `VECTOR_PROVIDER` | hnswlib | main-win 建议用 sqlite（无需 native 编译） |
| `AUTONOMOUS_DRY_RUN` | "1" | 默认 dry run，真实推送需改为 "0" |
| `AUTONOMOUS_PUSH_ENABLED` | "0" | FCM 推送开关，默认关 |
| `QWEN_BASE_URL` | localhost:1234/v1 | 本地 LLM 地址 |
| `PLAN_GENERATION_CRON` | 0 6 * * * | plan 生成时间 |
| `LIFE_MEMORY_CRON` | off | 旧 life cron，保持 off |
| `PROACTIVE_MESSAGE_CRON` | \*/10 \* \* \* \* | 旧主动消息 cron，若完全迁移到 Phase B 可改 off |

---

## 11. P0 风险清单（对比旧 dev 分支）

| 风险项 | main-win 状态 | 待补 |
|--------|--------------|------|
| `fetch()` 裸调用无超时（LLM 可能无限挂） | **未修**（6 处）：`memoryDecisionService:66`、`lifeMemoryService:259`、`proactiveMessageDecisionService:128`、`fcm:39`；Phase A/B 新增的 `catchupService`、`proactivePlanService` 也是裸调用 | ✅ 需补 `fetchWithTimeout` helper |
| SIGTERM/SIGINT 优雅退出 | **部分**：handler 存在，调了 `wsShutdown()`，但 `setTimeout(process.exit, 100)` 仅 100ms，不足以等在途 LLM 调用（2-10s） | ✅ 需改为 8s |
| `interaction_log` 索引缺失 | **已消灭**：migration 006 DROP 了该表；`getRecentAssistantInteractions` 已改查 `conversation_turns`（有索引） | ✘ 无需处理 |
| `REQUIRE_API_KEY` 默认值与文档不符 | **未修**：`config.js:100` 默认 `"1"`，`.env.example:10` 写的是 `REQUIRE_API_KEY=0` | ✅ 需改默认为 `"0"` |
| Qdrant 相关依赖残留 | `@qdrant/js-client-rest` 仍在 `package.json dependencies`，但代码中已无任何引用 | 低优先级，可清理 |

**新增风险（main-win 引入）**：
- `proactiveMessageCron` 默认 `*/10 * * * *` 仍在跑（旧路径），和 Phase B plan executor 同时争同一批角色，双写 `character_behavior_journal`。建议在 `.env` 里设 `PROACTIVE_MESSAGE_CRON=off`。

---

## 12. 与旧 dev 分支（孤儿）的主要差异

| 维度 | 旧 dev（孤儿，已废弃） | main-win（当前） |
|------|----------------------|----------------|
| 文件数（src/） | 19 | 30 |
| 迁移数 | ~5 | 10 |
| 推送通道 | 仅 pull 轮询 | WS 直推 + pull 兜底 |
| 主动消息 | cron 判断 + 即时 LLM | Phase B plan 预生成 + executor |
| 生活记忆 | cron 定时生成 | Phase A lazy catchup（用户主动触发） |
| 离线同步 | 无 | POST /api/sync/push + 幂等 |
| 搜索 | 无 FTS | FTS5 trigram |
| 管理 UI | 无 | Phase D `/api/browse/*` + `public/` |
| Qdrant | 有 `@qdrant/js-client-rest` 依赖 | 依赖保留但代码未引用 |
