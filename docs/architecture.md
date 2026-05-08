# wi-chat-server 架构总览

> 写给不下载代码也能彻底理解本项目的人。本文不重复 README 已有的 API 用法，专注**内部机制 / 数据流 / 关键不变量**。
>
> 配套阅读：
> - `README.md` — 端到端 API 参考
> - `docs/offline-sync-plan.md` — sync 幂等设计
> - `docs/realtime-and-autonomous-redesign.md` — 主动消息与实时通道演进
> - `docs/storage-optimization-plan.md` — 存储瘦身路线
> - `docs/ai-tool-memory-recall-and-correct.md` — 客户端 LLM 工具集成手册
> - `docs/refactor-plan.md` — 重构任务进度（结构 / 设计问题逐项落地）
> - `docs/client-release-required.md` — 需客户端配合发版的事项
> - `docs/known-issues.md` — 已知存在但暂不修的问题（鉴权 / 写回竞态等）
> - `tests/retrieval/fixtures/README.md` — 检索回归 fixture 格式说明

---

## 1. 项目定位

**一个本地 SQLite-first 的角色对话后端**：负责**记忆持久化 + 语义检索 + 主动消息**三件事，本身不直接面向用户，而是给 chatbox-Android 这类客户端做"角色服务器"。

设计原则：
- **客户端权威**：phone 才是源头，所有写入都用 client-stamped UUID v7 实现幂等 —— server 重复推送只落一次。
- **SQLite 单写**：单进程 fork 模式，禁止 cluster；WAL 模式 + busy_timeout 5s。
- **AI 决策与启发式分离**：is-retrieve / classify / plan / correct 都有 AI 路径 + 兜底启发式，可独立切换。
- **outbox 解耦**：写主表 + 写事件，由 worker 异步消费 —— 主线写入永远不阻塞在向量计算 / LLM 调用上。

技术栈：
- Node.js ≥ 22（package.json `engines.node`）
- `better-sqlite3` 同步 API + WAL 模式
- `express` HTTP / `ws` WebSocket
- 向量索引：默认 SQLite 全表 cosine（`VECTOR_PROVIDER=sqlite`）；可选 `hnswlib-node` sidecar
- LLM：默认 LM Studio / Qwen（OpenAI-compatible），可换任何 OpenAI 兼容端点

### 1.1 快速跑起来

```bash
# 0. 准备：Node ≥ 22 + LM Studio 起 Qwen + embedding 模型
git clone <repo> && cd wi-chat-server
npm install
npm run setup            # 创建 .env + data/ 目录
$EDITOR .env             # 至少改 APP_API_KEY / QWEN_BASE_URL / EMBED_BASE_URL

# 1. 起服务（开发模式，foreground）
npm run dev
# → 监听 127.0.0.1:8787，自动跑 migrations，启动 indexer + scheduler

# 2. 推一条对话验证
curl -X POST http://127.0.0.1:8787/api/sync/push \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: dev-local-key' \
  -d '{"userId":"alice","turns":[{
    "id":"019e1234-5abc-7000-8def-ffeeddccbbaa",
    "assistantId":"asst-jasmine",
    "sessionId":"sess-1",
    "role":"user",
    "content":"我喜欢拿铁",
    "createdAt":1746700800000
  }]}'

# 3. 等 ~10s 让 indexer 跑完 embed，再检索
curl -H 'x-api-key: dev-local-key' \
  'http://127.0.0.1:8787/api/memory/search?assistantId=asst-jasmine&query=咖啡&topK=5'

# 4. 跑 fixture baseline（首次）
npm run eval:retrieval -- --write-baseline
```

生产用 `npm start`（pm2 fork 模式）。

---

## 2. 顶层架构图

```
                ┌──────────────────────────────────────────┐
                │          chatbox-Android (client)        │
                │  - 客户端 LLM 调用本地 / 云端模型          │
                │  - 本地缓存 + UUID v7 turn id             │
                └───────┬───────────────────┬──────────────┘
                  HTTP /api/sync/push      WebSocket /api/ws
                        │                   │
        ┌───────────────▼───────────────────▼───────────────┐
        │         wi-chat-server (Node.js, single proc)     │
        │                                                   │
        │  routes/         services/          workers/      │
        │  ├─ sync.js      ├─ memoryIngest    ├─ memory     │
        │  ├─ api.js       ├─ memoryRetrieval │   Indexer   │
        │  ├─ admin.js     ├─ memoryClassify  └─ retention  │
        │  ├─ browse.js    ├─ memoryDecision      Sweeper   │
        │  └─ /api/ws      ├─ memoryEdit                    │
        │                  ├─ proactivePlan    scheduler.js │
        │                  ├─ characterState   ├─ plan-gen  │
        │                  ├─ characterEngine  ├─ plan-exec │
        │                  ├─ knowledge        ├─ classify  │
        │                  ├─ catchup          ├─ retention │
        │                  └─ syncIngest       └─ backup    │
        │                                                   │
        │  ┌──────────────── SQLite (WAL) ────────────────┐ │
        │  │ conversation_turns / memory_items /         │ │
        │  │ memory_facts / memory_vectors / FTS5 /      │ │
        │  │ outbox_events / proactive_plans /           │ │
        │  │ character_state / local_outbox_messages …   │ │
        │  └─────────────────────────────────────────────┘ │
        └─────────────┬─────────────────────────────────────┘
                      │
        ┌─────────────┴──────────┐
        │  外部依赖（皆可关）       │
        │  - LM Studio / Qwen LLM │  classify / plan / decide
        │  - Embedding endpoint   │  vector / FTS
        │  - HNSW sidecar (可选)   │  ANN 加速
        └────────────────────────┘
```

> 历史遗物：FCM 推送通道 (`push_token` 表 + `services/fcm.js`) 仍在代码库中但**已不被新链路使用**，待 T-02（见 [refactor-plan.md](./refactor-plan.md)）+ 客户端发版同步删除。所有 push 已改走 WebSocket + `local_outbox_messages` 离线队列。

---

## 3. 进程组成与启动顺序

入口 `src/index.js`：

```
1. require('./db')               → 跑 schema migrations（事务内）+ 设 PRAGMA
                                  + assertVectorDim()（与 memory_vectors 校验）
2. attach 4 routers              → /api/sync /api /api/browse /admin + /public 静态
3. http.createServer + attachWebSocketServer  → /api/ws upgrade handler
4. server.listen
   ├─ startMemoryIndexer()       → 后台轮询 outbox_events 跑 embedding
   └─ startScheduler()           → 注册 5 个 cron + plan-executor setInterval loop
5. SIGINT/SIGTERM → wsShutdown(广播 server_shutdown 给所有 ws 客户端) → exit(0)
```

**6 个 cron**：

| 标签 | 默认表达式 | 作用 |
|------|-----------|------|
| `backup-daily` | `0 3 * * *` | jsonl.gz 增量备份 |
| `backup-weekly` | `30 2 * * 0` | SQLite 全量快照 |
| `retention-sweep` | `30 3 * * *` | 清过期日志 + WAL checkpoint + 月初 VACUUM |
| `memory-classify` | `*/10 * * * *` | LLM 分类 backfill（≤ 50+20 条/次） |
| `plan-generation` | `0 6 * * *` | 长期 trigger plan 生成 |
| `dead-letter-monitor` | `0 9 * * *` | 24h 死信巡检（T-14） |

外加 `plan-executor`：`setInterval` 每 60s 一次，扫到期 plan 派发。

**单进程多角色**：所有 worker / scheduler 都在同一个 Node 进程里。SQLite 不允许多写，所以 `ecosystem.config.js` 强制 `instances: 1, exec_mode: "fork"`。单进程内 `node-cron` 同名 schedule 不会重入，cron 互斥不需额外机制。

---

## 4. 数据模型

### 4.1 表分类（18 张主表 + 1 张 FTS5 虚表）

按职能划分：

```
[ 对话流 ]            conversation_turns                       — 唯一原文流水

[ 记忆抽象 ]          memory_items                             — 派生的语义单元（每条 user/assistant turn 1 条）
                     memory_items_fts                          — FTS5 trigram 全文索引
                     memory_facts                              — 结构化 fact (key→value, importance + confidence)
                     memory_edges                              — 记忆间关系图（temporal_next 等）
                     memory_vectors                            — int8 量化向量 blob (1028 字节/1024 维)
                     memory_audit_log                          — AI 编辑历史（migration 017）
                     memory_retrieval_log                      — 每次检索的得分明细（评估用，30d TTL）

[ 角色状态 ]          assistant_profile                        — 名字 / background / 开关 / type
                     character_state                           — mood / intimacy / energy 实时态（懒衰减）
                     character_behavior_journal                — 主动决策 / catchup 日志

[ 主动消息 ]          proactive_plans                          — pending → sent / cancelled

[ 通信通道 ]          outbox_events                            — 主表→worker 解耦
                     local_outbox_messages                     — WS 离线消息兜底（offline → reconnect flush）
                     dead_letter_events                        — outbox 重试 max 后的死信
                     push_token                                — FCM token（待 T-02 删除，已无写入）
                     sync_checkpoints                          — worker 进度游标

[ 调度 / 元数据 ]     schema_migrations                         — migrator 自身

[ LLM 审计 ]          provider_call_log                        — 所有 LLM 调用的入参/出参（14d TTL）
```

> 不在表里：T-08 计划把 `assistant_turn` 类 memory_items 全部移除（仅保留在 `conversation_turns`）；T-03 计划删除 `character_state.familiarity` 列。当前文档反映"今天的"事实状态。

### 4.2 关键 ER 关系

```
conversation_turns (1) ──┐
                          │ source_turn_id
                          ▼
                    memory_items (1) ──┬──── memory_facts (N)
                                       │
                                       ├──── memory_vectors (1，可空：assistant_turn 不入)
                                       │
                                       ├──── memory_edges (N，向 / 反向)
                                       │
                                       └──── memory_audit_log (N)

memory_items.memory_type ∈ ALLOWED_MEMORY_TYPES {  // src/db.js 强制
  'user_turn'        — 用户原话，主索引对象
  'life_event'       — catchup 服务合成的"叙事补叙"
  'work_event'       — 工作场景事件（保留扩展）
  'knowledge'        — kb 条目（user 显式录入，永不衰减）
}
// 注：role ∈ {assistant, tool_call, tool_result, system} 由 memoryIngestService 上游
// short-circuit，仅写 conversation_turns，**绝不进** memory_items（migration 024 一次性
// 清掉了历史 627 行 assistant_turn）。insertMemoryItem 入参校验会拒绝任何非法 type。

memory_items.memory_category ∈ {
  preferences / relationship_info / goals_plans / personal_experience /
  knowledge / decisions_reflections / ideas / wellbeing / chitchat
}（由 memoryClassificationService 异步打标，决定 recency 半衰期）

memory_items.quality_grade ∈ A | B | C | D | E（A 最严，D/E 不再被检索）
```

### 4.3 vector blob 格式（migration 007 + 当前优化）

```
[scale: float32 LE, 4 bytes][quantized: int8 × dim]
```

- 1024 维 → 1028 字节（vs 原 float32 4096 字节，省 75%）
- 实现：[sqliteVectorStore.js](../src/services/vectorProviders/sqliteVectorStore.js)
- 验证：top-10 召回 Jaccard = 1.000（int8 量化无信息损失）

### 4.4 FTS5

- 仅 `memory_items_fts` 一张（`conversation_turns_fts` 已 drop，migration 020）
- tokenizer：`trigram case_sensitive 0` —— 支持中文子串匹配，代价是索引膨胀 7-8x
- trigger 带 WHEN 子句（migration 021），仅在 content / memory_type / assistant_id 真变化时重建索引；cite_count 等高频更新对 FTS 透明

---

## 5. 三类输入路径

| 入口 | 写入路径 | 触发的副作用 |
|------|---------|--------------|
| `POST /api/sync/push` | `routes/sync.js` → `ingestTurnsBatch` | cancel pending plans (`user_active`) + character_state 更新 + async `scheduleNextPushPlan` |
| `POST /api/sync/snapshot` | `routes/sync.js` → assistants upsert + `ingestTurnsBatch` | 同上，加 assistants 一次性 phone-wins 覆盖 |
| WS `message_create` | `ws/server.js` → `ingestTurnsBatch`（单条数组） | 同 sync/push 一致，但走 setImmediate 异步触发 |
| WS `message_update` | `ws/server.js` → `updateConversationTurnContent` | content 改 + memory_item.vector_status='pending' 触发 re-embed；facts 不动 |
| Scheduler cron | `scheduler.js` → 5 个 cron + 1 个 setInterval loop | 见 §13 |

**所有路径都用同一个 `syncIngestService.ingestTurnsBatch`**——这是项目最重要的不变量之一：**对话写入只有一个真理函数**。

### 5.1 写入后的副作用：事件总线（T-09）

`ingestTurnsBatch` 自身只负责写主表。"派生反应"（取消 pending plans / 更新 character_state / 排下一条 next_push）通过事件总线分发：

```
sync.push / sync.snapshot / ws.message_create
         │
         │ 1. 调 ingestTurnsBatch（事务内写 conversation_turns + memory_items + outbox）
         │
         ▼ 2. 事务 commit 后，每 (assistant, batch) emit 一次：
   turnEvents.emitUserBatch({
     assistantId, userId, cause,
     stats: { userTurnCount, lastUserAt, lastUserContent }
   })
         │
         ▼ 3. 同步 fan-out 到 3 个 subscribers（src/subscribers/）
         │
         ├─ cancelPendingPlans.js     ← 同步 cancel long-term trigger 的 pending plan
         ├─ scheduleNextPush.js       ← setImmediate + scheduleNextPushPlan（含 LLM 调用）
         └─ characterStateUpdater.js  ← ensureDefaultState + upsert + onUserMessage（mood）
```

**约束**：
- emit 调用 **必须** 在 ingest 事务 commit 后（better-sqlite3 同步事务，函数返回即提交）
- subscriber 内部 try/catch + log，**不抛错**到 emit 调用方
- 长任务（LLM）subscriber 自己 setImmediate，不阻塞 emit 路径

**加新副作用**：写一个 `register(turnEvents)` 函数 + 在 [src/subscribers/index.js](../src/subscribers/index.js) 列表里加一行。不需要改 sync / ws 调用方。

---

## 6. 写入路径深度：sync 幂等设计

### 6.1 两层去重

```
turns[] (来自 phone)
   │
   ▼ 单事务批处理
┌────────────────────────────────────────────────────┐
│ for each turn:                                      │
│   ① turnId 命中？                                    │
│      → SELECT id FROM conversation_turns WHERE id=? │
│      → 命中 → status='skipped' reason='already_exists' (零写入)│
│   ② 逻辑 key 命中？                                   │
│      (assistantId, sessionId, role, createdAt)      │
│      → 命中 + content/tool 字段完全一致              │
│         → status='skipped' reason='logical_duplicate_of:<oldId>' │
│      → 命中 + content 不同                           │
│         → 级联硬删旧 turn + 衍生 (memory_item / facts │
│           / edges / vectors / outbox)                │
│         → 用新 id 写入                               │
│         → status='replaced' reason='replaced_old:<oldId>' │
│   ③ 无命中 → INSERT + 延伸 ingestInteraction          │
│              (仅对 user/assistant 触发 memory pipeline)│
└────────────────────────────────────────────────────┘
```

### 6.2 Clock correction

`createdAt < 2020-01-01` 或 `> now + 1d` → 矫正为 `Date.now()`，details 里附 `reason: "clock_corrected"`，仍算 accepted（[syncIngestService.js](../src/services/syncIngestService.js)）。

### 6.3 五种 role 的差异

T-08 之后只有 `user` 进 memory_items：

| role | 进 memory_items？ | 抽 fact？ | embed？ | 进 conversation_turns？ |
|------|--------------------|-----------|---------|------------------------|
| `user` | ✅ user_turn | ✅ LLM 异步抽 | ✅ | ✅ |
| `assistant` | ❌ | ❌ | ❌ | ✅ |
| `tool_call` | ❌ | ❌ | ❌ | ✅ |
| `tool_result` | ❌ | ❌ | ❌ | ✅ |
| `system` | ❌ | ❌ | ❌ | ✅ |

非 user role 的 turn 仅写 conversation_turns，FTS5 trigger 不覆盖（trigram 是 memory_items 专用）。检索 AI 自己说过什么用 `/api/search?scope=conversation`（针对 conversation_turns 直接 LIKE），不再走向量召回。

`insertMemoryItem` 里有 `ALLOWED_MEMORY_TYPES = {user_turn, life_event, work_event, knowledge}` 集合校验，错传非法 type 直接抛错。

### 6.4 调用示例

**HTTP — 客户端推一批 turns**：

```bash
curl -X POST http://127.0.0.1:8787/api/sync/push \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: dev-local-key' \
  -d '{
    "userId": "alice",
    "turns": [
      {
        "id": "019e1234-5abc-7000-8def-ffeeddccbbaa",
        "assistantId": "asst-jasmine",
        "sessionId": "sess-2026-05-08",
        "role": "user",
        "content": "我最近爱喝拿铁，每天早上一杯。",
        "createdAt": 1746700800000
      }
    ]
  }'
```

响应（每条 turn 一个 status）：

```json
{
  "ok": true,
  "results": [
    {
      "id": "019e1234-5abc-7000-8def-ffeeddccbbaa",
      "status": "accepted",
      "memoryId": "019e1234-5abc-7001-9000-...",
      "factCount": 0
    }
  ]
}
```

第二次推**同一 id** 会得到：

```json
{ "id": "019e1234-...", "status": "skipped", "reason": "already_exists" }
```

**WS — 同一逻辑用 `message_create` 帧**（见 §12.5 完整帧示例）。

---

## 7. 记忆管线（一条 user turn 的一生）

```
phone push (POST /api/sync/push)
    │
    ▼
┌────────────────────────────────────────┐
│ syncIngestService.ingestTurnsBatch     │
│  - 幂等去重 + clock correction          │
│  - 单事务整批                           │
└─────────────┬──────────────────────────┘
              │ for SEMANTIC_ROLES (user/assistant)
              ▼
┌────────────────────────────────────────┐
│ memoryIngestService.ingestInteraction  │
│  - INSERT conversation_turns            │
│  - INSERT memory_items                  │
│    salience = role+长度启发式估算        │
│  - INSERT memory_edges (temporal_next)  │
│  - INSERT outbox_events                 │
│      event_type='memory_item.created'   │
└─────────────┬──────────────────────────┘
              │
              │ 返回 HTTP ack（不阻塞）
              │
              ▼ async
┌────────────────────────────────────────┐
│ workers/memoryIndexer (poll loop)       │
│  ① fetchPendingEvents                   │
│  ② processEvent                         │
│     IF memory_type='assistant_turn':    │
│       SET vector_status='skipped' →exit │
│     ELSE:                               │
│       embedText(content)                │
│       vectorStore.upsert                │
│       SET vector_status='ready'         │
│  ③ markDone(event)                      │
│  失败 → retry_count++ + 退避 → max 后入  │
│         dead_letter_events              │
└────────────────────────────────────────┘
              │
              │ 同时（独立 cron）
              ▼
┌────────────────────────────────────────┐
│ scheduler.runMemoryClassifyBackfillTick │
│   每 10min 跑一批：                      │
│   ① backfillUnclassified ≤50 条          │
│      heuristic 先尝试，confidence<0.6   │
│      → 调 LLM 拿 {category, quality,    │
│         confidence, facts:[{key,value,  │
│         confidence,importance}]}        │
│      → SET memory_category /            │
│          quality_grade /                │
│          INSERT memory_facts            │
│   ② backfillMissingFacts ≤20 条          │
│      已分类但 facts 空的事实型 →跑 LLM   │
└────────────────────────────────────────┘
```

**为什么 assistant_turn 完全不入 memory_items**（T-08）：实测 625 条 `assistant_turn memory_items` 抽出 **0 条 fact**，AI 自己说的话语义稀释、占据 top-K 候选位、挤出真正有价值的 user_turn。migration 024 一次性清了历史 627 行；新 ingest 路径上 assistant role 直接 short-circuit 成 logOnly。详见 [storage-optimization-plan.md](./storage-optimization-plan.md)。

### 7.1 ingestInteraction 函数签名

**所有写路径最终都汇到这一个函数**（[memoryIngestService.js](../src/services/memoryIngestService.js)）：

```js
const { ingestInteraction } = require("./services/memoryIngestService");
const {
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  findMemoryItemBySourceTurnId,
  db,
} = require("./db");

const result = ingestInteraction({
  db,
  assistantId: "asst-jasmine",
  sessionId:   "sess-2026-05-08",
  role:        "user",                    // user | assistant | tool_call | tool_result | system
  content:     "我最近爱喝拿铁。",
  now:         Date.now(),                // = createdAt，会被存进 conversation_turns + memory_items
  turnId:      providedUuidV7,            // 可选；不传则 server 生成（破"客户端权威"原则，仅 admin 等内部用）
  toolCallsJson: null, toolCallId: null, toolName: null,  // tool_call/result 才填
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  findMemoryItemBySourceTurnId,
});

// returns:
//   { turnId, memoryId, factCount, skipped: false }
//   或 log-only role: { turnId, memoryId: null, factCount: 0, skipped: false, logOnly: true }
//   或同 source_turn_id 已存在: { turnId, memoryId: <existing>, factCount: 0, skipped: true }
```

**幂等关键**：`insertConversationTurn` 是 `INSERT OR IGNORE`，重复 turnId 不报错；`memory_items` 写前过 `findMemoryItemBySourceTurnId` 短路；`outbox_events.dedupe_key` 唯一约束兜底。

---

## 8. 检索系统（`memoryRetrievalService.retrieveMemory`）

### 8.1 双路径：SQL-first vs vector-first

```
有窄时间窗 (≤31 天)？
  ├─ YES → SQL-first
  │        SELECT id FROM memory_items WHERE assistant_id+时间窗+类型/分类/质量
  │        所有候选都参与 ranking，避免"高 salience 但语义弱"的老记忆被向量近邻挤出
  │
  └─ NO  → vector-first（默认）
           vectorStore.search topK*N (有 filter 时 *5，否则 *2，最少 20)
           HNSW sidecar 优先 → fallback 到 sqlite 全表 cosine
```

### 8.2 默认候选池排除（已优化）

```js
DEFAULT_TYPES = ["user_turn", "life_event", "work_event", "knowledge"]
// 不带 assistant_turn —— 调用方想要 AI 自己说过的话需显式 source='character' 或 'all'
```

### 8.3 多因子加权评分

```
finalScore =
    semantic        × 0.42    // cosine 相似度，归一化到 [0,1]
  + recency         × 0.18    // 指数衰减 + floor 0.15
  + salience        × 0.10    // ingest 时根据 role+长度估算
  + confidence      × 0.08    // 由 LLM classify 时给出
  + qualityScore    × 0.10    // A=1.0 / B=0.8 / C=0.6 / D=0.3 / E=0.0
  + citePopularity  × 0.05    // log1p(cite_count)/log(50)
  + edgeBoost       × 0.05    // graph 上邻居权重，已批量化（无 N+1）
  + sessionBoost(±0.02)        // 同 session 命中 +0.02
```

### 8.4 recency 衰减细节

```
score = floor + (1 - floor) * 0.5^(deltaDays / effectiveHalfLife)
  floor = 0.15
  effectiveHalfLife = baseHalfLife(category) * (1 + log1p(citeCount) * 0.5)

baseHalfLife (天):
  preferences/relationship_info: 180   ← 长期偏好不易过期
  goals_plans/personal_experience/knowledge/decisions_reflections: 90
  ideas: 60
  wellbeing: 30                         ← 情绪有时效
  chitchat: 14                          ← 闲聊快忘
  其它默认: 60

特殊：memory_type='knowledge' → recency 永远 = 1.0（不衰减）
```

### 8.5 副作用与防护

- 命中行 `cite_count++` + `last_cited_at = now`（巩固效应）—— 但 trigger WHEN 子句保证 FTS 不重建
- 默认排除最近 60s 同 session 的 user_turn（防 sync-push echo）
- 写 `memory_retrieval_log`（每次检索的 ids + 分数明细，供评估用）

### 8.6 LLM 决策开关

`memoryDecisionService.shouldRetrieveMemory` 在 `/api/tool/memory-context` 链路里被先调用：
- AI 优先：调 LLM 拿 `{shouldRetrieve, intent, reason, query}`
- 失败回退到启发式：含记忆关键词 / `content.length >= 12` 触发
- 5 个 intent：`fact_query / continuation / care_response / small_talk / task_only`
- `task_only` / `small_talk` 不召回，省 LLM token

### 8.7 检索调用示例

```js
const { retrieveMemory } = require("./services/memoryRetrievalService");

const results = await retrieveMemory({
  assistantId: "asst-jasmine",
  sessionId:   "sess-2026-05-08",
  query:       "我最爱的咖啡是什么？",
  topK:        8,                          // 默认 config.retrievalTopK = 8
  source:      "user",                     // "user" | "character" | "knowledge" | "all" | null（默认排除 assistant_turn）
  withinDays:  30,                         // 时间窗：触发 SQL-first 路径
  minScore:    0.4,                        // finalScore 阈值
  minQuality:  "B",                        // 排除 D/E
  kbName:      null,                       // 知识库过滤（仅 source='knowledge' 有意义）
  includeFacts: true,                      // 一并返回 memory_facts 行
  excludeRecentEcho: true,                 // 默认 true：屏蔽最近 60s 同 session 的 user_turn
});

// 返回结构：
[
  {
    id: "019e1234-5abc-7001-...",
    content: "我最近爱喝拿铁。",
    memory_type: "user_turn",
    memory_category: "preferences",
    quality_grade: "A",
    salience: 0.62, confidence: 0.8, cite_count: 3,
    score: 0.86,                           // 加权 finalScore
    breakdown: {                           // 8 因子明细
      semantic: 0.91, recency: 0.78, salience: 0.62,
      confidence: 0.80, qualityScore: 1.00, citePopularity: 0.36,
      edgeBoost: 0.00, sessionBoost: 0.02
    },
    facts: [{ key: "favorite_drink", value: "拿铁", importance: 0.7, confidence: 0.85 }]
  },
  // ...
]
```

### 8.8 检索回归 fixture（T-13）

- [tests/retrieval/fixtures/](../tests/retrieval/fixtures/) 14 个 fixture，每个声明：seed turns + query + 期望命中规则。
- [scripts/eval-retrieval.js](../scripts/eval-retrieval.js) 跑分器输出 Recall@5 / MRR / per-fixture pass/fail。
- 命名空间隔离：所有 fixture 的 `assistant_id` 以 `eval-fix-` 开头，跑前 wipe 该命名空间，**不污染**生产 conversation_turns。
- baseline 写到 `tests/retrieval/baseline.json`；改任何评分权重前先 `--write-baseline`，改完 `--compare-baseline` 验证不退化。
- `RETRIEVAL_STRATEGY_VERSION` 常量 = "v1"（[memoryRetrievalService.js:29](../src/services/memoryRetrievalService.js#L29)）；改公式形态时 bump 到 v2，按 strategy 切片对比。

---

## 9. 主动消息（proactive plan）

### 9.1 双模式

```
                       近 72h 用户活跃？
                        ┌────┴────┐
                       YES         NO
                        │           │
                        ▼           ▼
                  next_push     长期 trigger
                 (事件驱动)      (cron 驱动)
                        │           │
                        │           ├─ inactive_7d  (沉默 7 天唤醒)
                        │           ├─ daily_greeting (固定时段问候)
                        │           └─ manual_request (admin 手触)
                        │           │
                        ▼           ▼
                  proactive_plans 表 (pending → sent / cancelled)
                        │
                        ▼
                 plan-executor (60s 一次)
                  ├─ WS 在线 → broadcastToUser
                  └─ WS 离线 → enqueueLocalOutboxMessage
```

### 9.2 next_push 事件链

```
user role turn 落库 (sync/push 或 ws message_create)
    │
    ▼
cancelPendingPlansForAssistant(aid, "user_active")  ← 清掉长期 plan
    │
    ▼
setImmediate(scheduleNextPushPlan)   ← 不阻塞 HTTP 响应
    │
    ▼
proactivePlanService.scheduleNextPushPlan
    ├─ now - lastUserAt > 72h → skip 'past_72h_handover_to_long_term'
    ├─ cancel 旧 next_push pending（同一时刻只许 1 条）
    ├─ buildNextPushPrompt
    │   上下文：character_background + coreFacts + lifeEvents
    │            + 最近 6 条 turns + 用户上一句 + 当前时间
    └─ callLlmForPlanDraft (T=0.75, max=600)
        ├─ {skip: true, skipReason: "用户在忙"} → 不插 plan
        └─ {intent, title, body, anchorTopic, rationale, delayMs}
           → INSERT proactive_plans (pending, scheduled_at = now + delayMs)
```

派发完一条 `next_push` 后（[scheduler.js `scheduleNextPushPlan`](../src/scheduler.js)），plan-executor 立刻给同一 assistant 再 `scheduleNextPushPlan`，让 AI 自己决定连续推还是 skip。

### 9.3 派发与登记

`runPlanExecutorOnce`（[scheduler.js](../src/scheduler.js)）：

```
fetchDuePendingPlans(now)
    │
    ▼ for each plan
    ├─ getActiveSocketCount(plan.user_id) > 0 ?
    │   ├─ YES → broadcastToUser({op:'proactive', ...})
    │   │        markPlanSent + recordProactiveAsTurn
    │   └─ NO  → enqueueLocalOutboxMessage (TTL=7d 默认)
    │            markPlanSent + recordProactiveAsTurn
    │
    └─ recordProactiveAsTurn:
        把 plan.draft_body 当作 assistant role 写进
        conversation_turns + memory_items（用 plan.id 当 turnId 保幂等）
        ↑ 这样 server 看得见自己说过什么，next_push 下次 prompt 不重复
```

### 9.4 cancel 原因清单

| reason | 触发 |
|--------|------|
| `replaced_by_new_turn` | 同 assistant 又来新 turn，旧 next_push 被替换 |
| `user_active` | 用户主动发消息，长期 trigger plan 被 cancel |
| `past_72h_handover_to_long_term` | 72h 没回，next_push 不再排，残留 pending 清掉 |
| `scheduled_beyond_72h_window` | LLM 给的 delay 加上 lastUserAt 已超 72h 边界 |
| `manual` | DELETE /api/proactive/plans/:id |

### 9.5 dedup + 安静时段

- Jaccard 相似度 ≥ 0.55 命中最近 10 条 assistant 消息 → 改写或丢弃（[textDedupService.js](../src/services/textDedupService.js)）
- `PROACTIVE_BLACKLIST` 屏蔽 10 条通用问候（"在吗" 之类）
- `quietHours` 字段（如 `"23-7"`）落在窗内 → reschedule 到窗外，**不静默丢弃**

### 9.6 自递归限流（T-15）

派发完一条 next_push 后，plan-executor 立刻给同一 assistant 再 schedule。LLM 抽风可能让 delay 越变越小自旋。`scheduleNextPushPlan` 在 cancel 旧 pending 之前有两道闸门：

```js
// 1. 距离上一条主动消息最少间隔 30 分钟
const lastProactiveAt = getLastProactiveAt(assistantId);
if (lastProactiveAt && now - lastProactiveAt < NEXT_PUSH_MIN_GAP_FROM_LAST_MS /* 30min */) {
  return { ok: false, skipped: "min_gap_from_last_proactive" };
}

// 2. 24h 滑窗 next_push 派发数 ≥ 12 条 → 拒绝
if (countNextPushIn24h(assistantId, now) >= NEXT_PUSH_24H_MAX_COUNT /* 12 */) {
  return { ok: false, skipped: "next_push_24h_cap_exceeded" };
}
```

两道闸门都在 LLM 调用之前，不会浪费 token。即便 LLM 持续返回 `delayMs=1000`，单 assistant 24h 内最多收到 12 条主动消息（~每 2h 一条）。

### 9.7 LLM plan draft 输出 schema

`callLlmForPlanDraft` 的 `response_format=json_object`，期望返回二选一：

```json
// 选 A：决定不发
{
  "skip": true,
  "skipReason": "用户刚发了消息，不打扰"
}

// 选 B：决定发，附时延
{
  "intent": "follow_up_topic",
  "title": "最近练琴感觉怎么样？",
  "body": "前两天你说手指疼，今天好点没？",
  "anchorTopic": "学吉他",
  "rationale": "用户三天前提到学吉他手指疼，正好关心一下",
  "delayMs": 7200000
}
```

Server 拿到 B 之后：
- 校验 `delayMs ∈ [60s, 72h]`
- `scheduled_at = now + delayMs`，若超 72h 边界 → cancel reason `scheduled_beyond_72h_window`
- 写 `proactive_plans` 一行 `status='pending'`

派发时（plan-executor 60s tick）：
```
SELECT * FROM proactive_plans
 WHERE status='pending' AND scheduled_at <= ?
 ORDER BY scheduled_at ASC LIMIT 50
```

---

## 10. 角色情绪 / 关系 / 精力（character_state）

### 10.1 三层数据

```
character_state 行（每个 assistant 一行）
├─ mood             — 27+95 GoEmotions 词库 (emotionTaxonomy.js)
│   ├─ emotion       (id 字符串，如 "calm" / "excited")
│   ├─ valence       [-1, 1]   效价（负面 → 正面）
│   ├─ arousal       [0, 1]    激活度（平静 → 兴奋）
│   └─ intensity     [0, 1]    强度
├─ relationship
│   ├─ intimacyScore [0, 200]  累积亲密分（连续）
│   ├─ level         {-2..9}   12 档（冷战 → 灵魂伴侣，由 score 映射）
│   ├─ familiarity   floor(total_turns/3) capped 100  ⚠️ 已折旧（T-03 + CR-02 后删除）
│   └─ totalTurns
├─ energy            [0.1, 1]  精力，沉默期会衰减
└─ focus             话题焦点 + 已深入轮次
```

> ⚠️ **familiarity 折旧**：客户端应只读 `relationship.level`（12 档整数），不读 `familiarity`。等客户端发版后，T-03 会通过 migration rebuild 删掉这一列。详见 [client-release-required.md CR-02](./client-release-required.md#cr-02-不再读-familiarity-字段对应服务端-t-03)。

### 10.2 衰减 vs 写入

**懒衰减**：所有读都过 `getEffectiveState(assistantId, now)`（[characterStateService.js:185](../src/services/characterStateService.js#L185)），按时间应用：

```
mood.valence  → BASELINE_VALENCE  (0.1)，半衰期 6h
mood.arousal  → BASELINE_AROUSAL  (0.2)，半衰期 6h
mood.intensity → BASELINE_INTENSITY (0.3)，半衰期 6h
energy        → 0.7，半衰期 8h（仅在 >60s idle 后开始恢复）
```

**写入触发**：
- `onUserMessage(assistantId, {content, now})` —— sync/push / WS message_create 入库 user-role 后调用
  - `scoreHeuristicSignals(content)` 启发式：deep_share / positive / negative
  - `detectSilenceEffect()`：>30d → 重置 calm；>7d 且 level≥3 → lonely + level -2；>2d → lonely
  - 应用 intimacyDelta / moodSuggestion / energyDelta（启发式）
- `applyMoodEvent(assistantId, {emotion, intensityDelta, intimacyDelta})` —— AI 决策直接覆盖（旁路启发式）

### 10.3 主动消息门槛（characterEngine）

`shouldAllowAutonomousMessage(assistantId)`（[characterEngine.js:47](../src/services/characterEngine.js#L47)）：

```
- last_proactive_at 距今 < 2h → block (interval guard)
- last_user_message_at 距今 < 30min → block (recent-activity guard)
- 当前在 quietHours 内 → block
- 否则 allow，buildProactivePrompt 拼上 familiarity 档位 + timeBucket
```

> familiarity 档位是当前实现，T-03 后会改为 `relationship.level` 直接映射档位。

### 10.4 客户端拉取

`/api/relationship/state` 和 `/api/character/bootstrap` 都返回 `relationshipState` payload（同 schema）。`character_state` 行不存在时 `ensureDefaultState` 自动以默认值（calm / 陌生人 / energy 0.7）填一行，永不返回 404。

```bash
curl -H 'x-api-key: dev-local-key' \
  'http://127.0.0.1:8787/api/relationship/state?assistantId=asst-jasmine'
```

```json
{
  "ok": true,
  "relationshipState": {
    "mood":  { "emotion": "calm", "valence": 0.12, "arousal": 0.20, "intensity": 0.30 },
    "relationship": {
      "intimacyScore": 47,
      "level": 2,
      "levelLabel": "熟人",
      "familiarity": 30,
      "totalTurns": 92
    },
    "energy": 0.68,
    "focus":  { "topic": null, "depth": 0 },
    "lastUserMessageAt":  1746698400000,
    "lastProactiveAt":    1746694800000
  }
}
```

---

## 11. 知识库 + 关键记忆（migration 018）

两个独立机制，都在 `memory_items` 表里加字段实现：

### 11.1 知识库（kb_name）

- `memory_type='knowledge'` 的 memory_items
- `kb_name` 字段标识所属知识空间，`kb_tags_json` 存标签
- `confidence=1.0` / `quality_grade='A'`，retrieval recency 永不衰减
- 由 `knowledgeService.upsertKnowledgeItem` 写入（[knowledgeService.js](../src/services/knowledgeService.js)）
- API：`POST /api/knowledge/upsert` / `GET /api/knowledge/:kbName/items`
- `kbName` 参数可在 retrieval 阶段过滤，把检索范围锁死在某个知识空间里

### 11.2 关键记忆（is_pinned）

- `memory_items.is_pinned = 1` + `pinned_at` 时间戳
- 任何 memory_type 都可 pin
- `/api/character/bootstrap` 的 `coreMemories[]` 字段：返回 pinned=1 的 memory_items，按 `(salience DESC, pinned_at DESC)` 排，最多 8 条
- 客户端把这些原文 + `coreFacts` 注入 system prompt，让 AI 永远"记得"

### 11.3 coreFacts 评分

`getCoreFacts`（[memoryEditService.js:467](../src/services/memoryEditService.js#L467)）：

```
score = importance * 0.6 + confidence * 0.4
filter: score >= 0.55
order:  score DESC
dedup:  by fact_key (only top per key)
limit:  15
```

`importance` 与 `confidence` 正交：
- `importance` = "对角色行为影响多大"（健康/重大身份 0.9+，偏好兴趣 0.3-0.5）
- `confidence` = "提取得准不准"（来自 LLM classify 输出）

### 11.4 知识库 API 示例

```bash
# 写入一条知识
curl -X POST http://127.0.0.1:8787/api/knowledge/upsert \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: dev-local-key' \
  -d '{
    "assistantId": "asst-jasmine",
    "kbName": "company-onboarding",
    "content": "公司报销流程：登录 OA → 提交申请 → 主管审批 → 财务打款。",
    "tags": ["reimbursement", "hr"]
  }'
# → { "ok": true, "id": "019e...", "created": true }

# 列出某 kb 下所有条目
curl -H 'x-api-key: dev-local-key' \
  'http://127.0.0.1:8787/api/knowledge/company-onboarding/items?assistantId=asst-jasmine'
```

检索时把范围锁死在某 kb：

```js
retrieveMemory({
  assistantId: "asst-jasmine",
  query: "公司怎么报销？",
  source: "knowledge",
  kbName: "company-onboarding",   // 只查这个空间，不会跨 kb 串
  topK: 5,
});
```

### 11.5 关键记忆 pin 示例

```js
const { setMemoryPinned } = require("./services/memoryEditService");

setMemoryPinned("019e1234-...", true, {
  assistantId: "asst-jasmine",
  actor: "user",                    // user | system | ai-tool 等审计字段
  reason: "用户手动加入关键记忆",
});
```

`/api/character/bootstrap` 返回的 `coreMemories[]` 就是从这里筛出来的：

```json
{
  "coreMemories": [
    { "id": "019e...", "content": "我有先天性心脏病...", "salience": 0.9, "pinnedAt": 1746000000000 }
  ],
  "coreFacts": [
    { "factKey": "health_condition", "factValue": "先天性心脏病", "importance": 0.95, "confidence": 0.9 }
  ]
}
```

---

## 12. WebSocket 实时通道

### 12.1 连接生命周期

```
client                                server
  │ ws://host:port/api/ws?apiKey=&userId=
  │─────────────────────────────────►│ 验 apiKey + userId
  │                                  │ register(userId, ws) → userIdToSockets Map
  │◄─────────────{op:hello, ts}──────│
  │                                  │ flushPendingForUser → queued_batch（如有积压）
  │◄─────────{op:queued_batch, ...}──│
  │                                  │
  │ {op:ping, ts} (every 25s)        │
  │─────────────────────────────────►│
  │◄────────────{op:pong, ts}────────│
  │                                  │
  │ {op:message_create, turn}        │
  │─────────────────────────────────►│ ingestTurnsBatch (单条数组)
  │◄────{op:message_persisted, ok}───│ + setImmediate(scheduleNextPushPlan)
  │                                  │
  │ {op:ack, id, status}             │
  │─────────────────────────────────►│ ackPulledMessage → local_outbox_messages.status='acked'
  │                                  │
  │◄────{op:proactive, ...}──────────│ broadcastToUser (scheduler.runPlanExecutorOnce)
  │ {op:ack, id}                     │
  │─────────────────────────────────►│
  │                                  │
  │ close / heartbeat timeout        │
  │ ⇄                                │ unregister + 自动从 Map 移除
```

### 12.2 心跳双层

- App-level：client 每 25s `{op:'ping'}`，server 回 `{op:'pong'}`
- TCP-level：server 每 25s 发 RFC 6455 ping 帧，超过一周期没 pong → `terminate()`

### 12.3 离线兜底

当 user 没有活跃 socket：

```
plan / proactive 消息 → enqueueLocalOutboxMessage
  → local_outbox_messages 表，TTL = config.localPullMessageTtlMs (默认 7d)
  
client 重连 → ws.send({op:'hello'})
  → flushPendingForUser pull 50 条 pending
  → 一帧 {op:'queued_batch', messages:[...]}
  
client 处理后逐条 ack → status='acked' + acked_at
retentionSweeper 定期清掉 acked > 30 天的行
```

### 12.4 关闭广播

`SIGTERM/SIGINT` → `wsShutdown()`（在 index.js 里别名引入 [ws/connections.js:77 `shutdown`](../src/ws/connections.js#L77)）：
- 给所有连接广播 `{op:'server_shutdown'}`
- `ws.close(1001, 'server_shutdown')` 优雅断开
- client 应在收到此帧后退避重连（避免 thundering herd）

### 12.5 WebSocket 帧 schema

**所有帧都是单行 JSON**，必须有 `op` 字段。

**握手 hello（server → client，连上立刻发）**：
```json
{ "op": "hello", "ts": 1746700800000, "userId": "alice" }
```

**心跳（双向，每 25s）**：
```json
{ "op": "ping", "ts": 1746700825000 }
{ "op": "pong", "ts": 1746700825010 }
```

**客户端写入 turn（client → server）**：
```json
{
  "op": "message_create",
  "turn": {
    "id": "019e1234-5abc-7000-8def-ffeeddccbbaa",
    "assistantId": "asst-jasmine",
    "sessionId": "sess-2026-05-08",
    "role": "user",
    "content": "我最近爱喝拿铁。",
    "createdAt": 1746700800000
  }
}
```

服务端回应：
```json
{
  "op": "message_persisted",
  "id": "019e1234-...",
  "status": "accepted",
  "memoryId": "019e1234-5abc-7001-..."
}
```

**修改已存 turn 内容**（client → server）：
```json
{
  "op": "message_update",
  "turn": { "id": "019e1234-...", "content": "我最近爱喝美式咖啡。" }
}
```
→ 服务端 `UPDATE conversation_turns` + 标 `memory_items.vector_status='pending'` 让 indexer 重 embed。

**主动消息（server → client）**：
```json
{
  "op": "proactive",
  "id": "019e2345-...",
  "assistantId": "asst-jasmine",
  "title": "最近练琴感觉怎么样？",
  "body": "前两天你说手指疼，今天好点没？",
  "intent": "follow_up_topic",
  "ts": 1746708000000
}
```
客户端处理后必须 ack：
```json
{ "op": "ack", "id": "019e2345-...", "status": "delivered" }
```

**重连后离线消息批量下发（server → client）**：
```json
{
  "op": "queued_batch",
  "messages": [
    { "id": "019e...", "messageType": "character_proactive", "payload": {...}, "createdAt": 1746... },
    { "id": "019e...", "messageType": "character_proactive", "payload": {...}, "createdAt": 1746... }
  ]
}
```

**关闭广播（server → client）**：
```json
{ "op": "server_shutdown", "ts": 1746710000000 }
```

---

## 13. 后台 worker

### 13.1 memoryIndexer（poll loop）

```
startMemoryIndexer (workers/memoryIndexer.js)
  while true:
    fetchPendingEvents(batch=20)
    if none → adaptive backoff (idle streak * 2)
    else for each:
      processEvent (单条事务)
      if error: retry_count++, next_retry_at = now + exp_backoff
      if retry_count >= max (5): INSERT INTO dead_letter_events; status='dead'
```

**关键设计**：每条 `outbox_event` 的 `dedupe_key` 唯一，重复 enqueue 会因 UNIQUE 失败 —— 上游 ingestInteraction 用 `INSERT OR IGNORE`，幂等天然保证。

**outbox_event 一行长这样**：

```js
{
  id: "019e1234-...",
  event_type: "memory_item.created",       // 也可能是 memory_item.updated
  aggregate_type: "memory_item",
  aggregate_id: "<memory_item.id>",        // 给 indexer 一把 key 回查
  dedupe_key: "memory-index:019e1234-...", // UNIQUE，重写也只算一次
  payload_json: '{"memoryId":"019e1234-..."}',
  status: "pending",                       // pending | done | dead
  retry_count: 0,
  next_retry_at: null,
  created_at: 1746700800000,
  updated_at: 1746700800000
}
```

indexer 处理一条事件的伪代码：

```js
function processEvent(event) {
  const memory = db.prepare("SELECT * FROM memory_items WHERE id=?").get(event.aggregate_id);
  if (memory.memory_type === "assistant_turn") {
    db.prepare("UPDATE memory_items SET vector_status='skipped' WHERE id=?").run(memory.id);
    return markDone(event);
  }
  const vector = await embedText(memory.content);
  await vectorStore.upsert({ memoryId: memory.id, assistantId: memory.assistant_id, vector });
  db.prepare("UPDATE memory_items SET vector_status='ready', vector_updated_at=? WHERE id=?")
    .run(Date.now(), memory.id);
  markDone(event);
}
```

### 13.2 retentionSweeper（cron 03:30 daily）

清理这些表（[workers/retentionSweeper.js](../src/workers/retentionSweeper.js)）：

| 表 | 默认 TTL | 配置项 |
|----|----------|--------|
| `memory_retrieval_log` | 30d | `RETENTION_RETRIEVAL_LOG_DAYS` |
| `outbox_events` (status IN done/consumed) | 7d | `RETENTION_OUTBOX_CONSUMED_DAYS` |
| `local_outbox_messages` (acked) | 30d | `RETENTION_LOCAL_ACKED_DAYS` |
| `provider_call_log` | 14d | `RETENTION_PROVIDER_CALL_LOG_DAYS` |
| `memory_audit_log` | 90d | `RETENTION_AUDIT_LOG_DAYS` |
| `character_behavior_journal.input_json/result_json` | 90d → 压缩为 `{}` | `BEHAVIOR_JOURNAL_PRUNE_DAYS` |

每次 sweep 还会：
- `INSERT INTO memory_items_fts(memory_items_fts) VALUES('optimize')` — 合并 FTS segments
- `PRAGMA wal_checkpoint(TRUNCATE)` — 截断 WAL
- 月初 1 号触发 `VACUUM` 全量回收

返回 `dbSizeBefore/After/Delta` 字节数到 scheduler 日志，监控趋势。

### 13.3 backup（cron 02:30 weekly + 03:00 daily）

- `daily`: jsonl.gz 增量（保留 8 天）
- `weekly`: SQLite 全量快照 `data/backups/full-YYYY-Www.sqlite`（保留 4 周）
- 恢复：`scripts/restore.js` 自动 `.restore-bak.<timestamp>` 备份原文件后覆盖

### 13.4 dead-letter 巡检（T-14, cron 09:00 daily）

`runDeadLetterMonitorTick`（[scheduler.js](../src/scheduler.js)）每天扫一次 24h 内入死信的事件数：

```js
const recent = db
  .prepare("SELECT COUNT(*) AS n FROM dead_letter_events WHERE created_at >= ?")
  .get(Date.now() - 24*60*60*1000);

if (recent.n > 0) {
  console.warn(`[scheduler] dead-letter monitor: ${recent.n} new in last 24h ...`);
  insertBehaviorJournalEntry({
    runType: "dead_letter_alert",
    status: "alert",
    reason: `${recent.n} dead-letter events in last 24h`,
    result: { recent24h: recent.n, total: ... },
  });
}
```

底层依赖修好后，用 `scripts/dead-letter-replay.js` 把死信复活回 outbox：

```bash
node scripts/dead-letter-replay.js                    # dry-run 列出
node scripts/dead-letter-replay.js --apply            # 全部 replay
node scripts/dead-letter-replay.js --apply --since 24h  # 仅最近 24h
node scripts/dead-letter-replay.js --apply --id <dlid>  # 指定一条
node scripts/dead-letter-replay.js --purge            # 清 outbox.status='dead' 残留
```

每条 replay：UPDATE outbox_events 状态回 'pending' + 清 retry_count + DELETE dead_letter_events 自身。indexer 下一轮自动捡。

---

## 14. LLM 调用矩阵

所有 LLM 调用走同一个 OpenAI-compatible client（默认 LM Studio / Qwen at `127.0.0.1:1234`）：

| 调用点 | 输入 | 输出 schema | 何时触发 |
|--------|------|-------------|----------|
| `langchainQwenService.generateWithMemory` | `{assistantName, userPrompt, memories[]}` | string (20-80 字回复) | `POST /api/chat-with-memory`（server-side 生成，不常用） |
| `memoryDecisionService.aiDecision` | 用户输入 + 最近上下文 | `{shouldRetrieve, intent, reason, query}`（5 个 intent 之一） | `POST /api/tool/memory-context` 进检索前 |
| `memoryClassificationService.classifyWithLLM` | memory_item.content + memory_type | `{category, quality, confidence, facts:[{key,value,confidence,importance}]}` | indexer 流转后 / `memory-classify` cron 每 10min 跑批 |
| `proactivePlanService.callLlmForPlanDraft` | character_background + coreFacts + 最近 turns + lastUserContent + 当前时间 | `{intent, title, body, anchorTopic, rationale, delayMs}` 或 `{skip, skipReason}` | `scheduleNextPushPlan` / cron `plan-generation` |
| `catchupService.runCatchup` | 上次互动到现在的 gap 时长 + 角色 background | `[{title, body, ts}, ...]` 多条 life_event | `POST /api/character/catchup`（client-driven） |

所有调用都写 `provider_call_log`（migration 012），方便审计与重放。

### 14.1 一次完整 LLM 调用日志（示例）

```js
// provider_call_log 一行 ≈
{
  id: "019e2300-...",
  provider: "qwen",
  callType: "classify",                  // chat | embed | classify | plan-draft | catchup
  model: "qwen2.5:7b-instruct",
  request_json: '{"messages":[...],"response_format":"json"}',
  response_json: '{"category":"preferences","quality":"A","confidence":0.85,"facts":[...]}',
  inputTokens: 487, outputTokens: 92,
  latencyMs: 1320, ok: 1, error: null,
  created_at: 1746700800000
}
```

便于：
- 回放：`scripts/run-plan-generator.js` 可以选某条历史 plan-draft 重跑
- 调试：检索结果异常时回查 classify 输出 → 看 LLM 是否打错 quality
- 成本审计：`SUM(input+output_tokens) GROUP BY callType` 看哪类调用最贵

---

## 15. 关键不变量（违反就出 bug）

1. **唯一对话写入**：所有 conversation_turn / memory_item / outbox 一定经过 `syncIngestService.ingestTurnsBatch` 或 `memoryIngestService.ingestInteraction`，绕过即破幂等。
2. **client-stamped UUID v7**：phone 端无限重推必须只落一次。server 永远不自己生成 turn id。
3. **SQLite 单写**：`ecosystem.config.js` 强制 fork 模式 + `instances:1`，禁止 cluster。
4. **WAL 模式**：`db.js` `journal_mode = WAL`。任何 `VACUUM` 都需要无活跃写连接。
5. **VECTOR_DIM 必须与 DB 一致**：`db.js` 启动时从 `memory_vectors.vector_dim` 反查权威值；与 `config.vectorDim` 不一致 → `process.exit(1)`。
6. **memory_type 受限集（T-08 后）**：`insertMemoryItem` 入参必须在 `ALLOWED_MEMORY_TYPES = {user_turn, life_event, work_event, knowledge}` 内；`assistant / tool_call / tool_result / system` role 全部 short-circuit 成 logOnly，绝不进 memory_items。
7. **MEMORY_ROLES 仅含 'user'**：[memoryIngestService](../src/services/memoryIngestService.js) 上游闸门，决定哪些 role 走 memory pipeline。
8. **同一时刻每 (assistant, user) 最多 1 条 pending next_push plan**：新 turn 会 cancel 旧 pending。
9. **next_push 24h 12 条 + 单条 30min 间隔（T-15）**：哪怕 LLM 抽风，单 assistant 不会被淹。
10. **vector_status 状态机**：`pending` → `ready` / `skipped` / 永远不会被 indexer 改成 `ready` 后又回到 `pending`（除非 `message_update` 或 `memory-correct update` 显式触发 re-embed）。
11. **memory_items_au trigger 必须带 WHEN 子句**：不带的话 cite_count update 也会让 FTS 写新 segment，几天就膨胀回去。migration 021 是这个不变量的保障。
12. **DEFAULT_TYPES 不含 assistant_turn**：T-08 后该值不存在；source='character' 仅返回 life_event/work_event。
13. **outbox dedupe_key 唯一**：重复 enqueue 因 UNIQUE 约束失败，上游 `INSERT OR IGNORE`，幂等天然保证。
14. **事件总线在事务 commit 后 emit（T-09）**：`turnEvents.emitUserBatch` 必须在 `ingestTurnsBatch` 返回后调用，不在 SQL 事务回调里 —— 避免 subscriber 抛错回滚主写。

---

## 16. 配置项速查（关键 env）

| Env | 默认值 | 作用 |
|-----|--------|------|
| `PORT` / `HOST` | 8787 / 127.0.0.1 | HTTP 监听 |
| `DATABASE_PATH` | `data/character-behavior.db` | SQLite 文件路径 |
| `APP_API_KEY` | `dev-local-key` | `x-api-key` 校验值 |
| `REQUIRE_API_KEY` | `0` | 是否强制校验 API key |
| `VECTOR_PROVIDER` | `hnswlib`（macOS）/ `sqlite`（main-win） | 向量检索后端 |
| `VECTOR_DIM` | 1024 | embedding 维度，启动时与 `memory_vectors.vector_dim` 校验一致，否则 fatal exit |
| `EMBED_BASE_URL` | — | embedding HTTP endpoint |
| `QWEN_BASE_URL` | `http://127.0.0.1:1234/v1` | LLM 调用 endpoint |
| `QWEN_MODEL` | `qwen2.5:7b-instruct` | LLM 模型 id |
| `RETRIEVAL_TOP_K` | 8 | 默认检索条数 |
| `RETENTION_SWEEP_CRON` | `30 3 * * *` | 03:30 daily 清理 |
| `PLAN_GENERATION_CRON` | `0 6 * * *` | 06:00 daily 长期 plan 生成 |
| `PLAN_EXECUTOR_INTERVAL_MS` | 60000 | plan executor 轮询间隔 |
| `MEMORY_CLASSIFY_CRON` | `*/10 * * * *` | 每 10min 分类 backfill |
| `DEAD_LETTER_MONITOR_CRON` | `0 9 * * *` | 每天 09:00 扫死信（T-14） |
| `BACKUP_DAILY_CRON` / `BACKUP_WEEKLY_CRON` | `0 3 * * *` / `30 2 * * 0` | 备份 |
| `LOCAL_PULL_MESSAGE_TTL_MS` | 7 * 24h | 离线消息保留 |
| `SCHEDULER_TIMEZONE` | `Asia/Shanghai` | cron 时区 |

---

## 17. Schema 演进史（migrations 速读）

```
001 init_memory                    起始 8 张表（含 memory_items / facts / edges / outbox / vectors-as-json）
002 add_memory_vectors             准备 vector_blob 字段
003 autonomous_persona             character_state（mood/intimacy/energy/totalTurns）
004 assistant_profile              assistant_profile（name/background/开关）
005 local_pull_outbox              local_outbox_messages（WS 离线兜底）
006 storage_hygiene                interaction_log → drop；autonomous_run_log → character_behavior_journal
007 vector_blob                    新 vector_blob BLOB 字段 + 索引
008 vector_blob_finalize           drop vector_json
009 fts5                           memory_items_fts + conversation_turns_fts (trigram)
010 proactive_plans                proactive_plans 表 + 索引
011 character_mood                 mood_emotion / valence / arousal / intensity / energy_value 字段
012 provider_call_log              LLM 调用审计
013 memory_category                memory_category / category_confidence / category_method / quality_grade /
                                   cite_count / last_cited_at（多因子排序的存档字段）
014 conversation_tool_columns      tool_calls_json / tool_call_id / tool_name 字段
015 drop_local_subscribers         旧 HTTP 轮询通道遗物清理
016 assistant_type                 assistant_type 字段（character/writer/default）
017 memory_audit_log               AI 编辑审计
018 knowledge_and_pinned           kb_name / kb_tags_json / is_pinned / pinned_at
019 memory_facts_importance        memory_facts.importance（与 confidence 正交）
020 drop_conversation_fts          砍掉 conversation_turns_fts（trigram 7x 膨胀）
021 fts_trigger_when_clause        memory_items_au 加 WHEN 子句（防 cite_count 触发 FTS 重建）
022 drop_legacy_proactive_log      删 proactive_message_log（旧 FCM 推送日志，新链路用 proactive_plans）
023 drop_scheduler_locks           删 scheduler_locks（单进程 cron 不需要分布式锁）
024 purge_assistant_turn_memory_items  清 627 行 assistant_turn 派生数据（T-08，conversation_turns 原文不动）
```

---

## 18. 给新接手者的"读代码顺序"

如果你是第一次接触这个仓库，按这个顺序读最快建立心智模型：

1. **`README.md` §1-3 §10**：先看用户怎么用（API + sync 协议）
2. **`src/index.js`**：30 行代码看清进程组成
3. **`src/db/migrations/001_init_memory.sql`**：起始 schema 是项目最核心的 8 张表
4. **`src/services/syncIngestService.js`**：唯一写入路径，搞清幂等
5. **`src/services/memoryIngestService.js`** + **`src/workers/memoryIndexer.js`**：写入 → 索引的异步链
6. **`src/services/memoryRetrievalService.js`**：检索是这个项目的核心算法
7. **`src/scheduler.js`**：看 5 个 cron + plan executor，理解后台节拍
8. **`src/services/proactivePlanService.js`**：最复杂的 service，里面双模式 + cancel 矩阵 + LLM prompt 都有
9. **`src/services/characterStateService.js`** + **`emotionTaxonomy.js`**：mood / 衰减算法
10. **`src/ws/server.js`**：实时通道 + 离线兜底

剩下的（admin / browse / knowledge / catchup / textDedup / fcm）都是各点上的工具或辅助，理解前面 10 个文件后再翻就轻松了。

---

## 19. 运维脚本

### 19.1 一次性重建派生数据 — `scripts/reinit-derived-data.js`

给定一个**只保留 `conversation_turns + assistant_profile`** 的 SQLite，重建所有派生层：memory_items / memory_facts / memory_edges / memory_vectors / outbox_events / character_state / proactive_plans / character_behavior_journal。

何时跑：
- 改了 ingest 逻辑 / 评分公式 / 向量维度 / classify schema 后想清洗存量
- 调试想从干净状态出发
- 新机器把对话原文 import 进来，要让派生层"长"出来

```bash
node scripts/reinit-derived-data.js                     # 全量重建（交互确认）
node scripts/reinit-derived-data.js --yes               # 跳过确认
node scripts/reinit-derived-data.js --dry-run           # 只盘点，不写
node scripts/reinit-derived-data.js --skip-classify     # 跳过 LLM 分类
node scripts/reinit-derived-data.js --reset-character-state  # 同时重置 mood/intimacy
node scripts/reinit-derived-data.js --assistant <id>    # 只重建某 assistant
```

### 19.2 检索回归 — `scripts/eval-retrieval.js`

见 §8.7。

---

> 文档维护：随主表结构 / 检索评分公式 / 主动消息状态机变化时同步更新。
> 最近一次大重构：
>   - 2026-05-08 存储优化（migration 020 + 021 + 向量 int8 量化 + assistant_turn 不入向量池），库体积 48.5 MB → 19.7 MB。
>   - 2026-05-08 历史包袱清理（migration 022 + 023 + VECTOR_DIM 校验 + RETRIEVAL_STRATEGY 常量化 + memory_type service 层断言），见 [refactor-plan.md](./refactor-plan.md)。
>   - 2026-05-08 检索 baseline + 重建脚本（T-13）：14 个 retrieval fixture + `eval-retrieval.js` 跑分 + `reinit-derived-data.js` 一键重建派生层。
>   - 2026-05-08 阶段 2/3 落地（T-08 / T-09 / T-14 / T-15）：assistant_turn 完全出 memory_items + ingest 事件总线 + dead-letter 巡检/重放 + plan-executor 自递归限流。
