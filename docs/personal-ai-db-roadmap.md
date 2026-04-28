# Personal AI Database — 能力缺口与建设路线图

> 基于 `main-win` 代码库完整审阅，记录于 2026-04-28。
> 目标形态：角色驱动 + 主动推送 + 长期记忆 + 跨会话离线同步 + WebSocket 实时推送。

---

## P0 — 阻塞核心功能或数据安全

### P0-1：embedding 无实体表，向量化依赖外部进程且无降级

**缺口**：`memory_vectors` 存了 BLOB 向量，但向量的生成完全依赖 `embedText()` 调用本地 embedding endpoint（`EMBED_BASE_URL`）。如果 endpoint 不可用，`outbox_events` 会无限重试直到 dead_letter，即 memory_items 永远无法被检索。没有 embedding 失败时的文本降级回退（例如用 FTS5 兜底检索）。

**推荐**：
1. `memoryIndexer.processEvent()` 里 embedding 失败时，在 `memory_items` 上设 `vector_status='embed_failed'` 并写 `dead_letter_events`；
2. `retrieveMemory()` 里当向量候选集为空时，fallback 到 `searchMemory(FTS5)` 返回 text hits，分数乘以 0.5 降权合并；
3. 长期：把 embedding 抽象成 provider interface（类似 vectorStore），支持 local-sentence-transformers / OpenAI / 纯 FTS 三种。

**工作量**：M（1-2天）

**阻塞下游**：离线时 memory_items 全部丢失可检索性；catchup 和 plan 生成依赖相关记忆检索，退化为 blind prompt。

---

### P0-2：SQLite 向量检索是 O(n) 全表扫，696 行已是上限

**缺口**：`sqliteVectorStore.search()` 把所有向量全部加载到 JS 内存做余弦相似度计算。696 行时 p99 约 20-50ms，但随着 memory_items 增长（每日对话积累），5000 行时单次检索会达到 200ms+ 且内存翻倍。

**推荐**：
1. 短期（S）：给 `sqliteVectorStore` 加 `LIMIT topK*4` 的时间预过滤（只扫最近 N 天的记忆），降低扫描量；
2. 中期（M）：默认切换到 `hnswlib` sidecar（本机已支持）；写一个启动检测脚本，若 sidecar 在线自动切换 `VECTOR_PROVIDER=hnswlib`；
3. 长期（L）：引入 sqlite-vec（SQLite 扩展，支持 ANN），消除独立进程依赖。

**工作量**：短期 S，中期 M

**阻塞下游**：数据增长后检索延迟劣化会直接影响 memory-context API 的响应时间。

---

### P0-3：记忆无加密，敏感 PII 明文存储

**缺口**：`memory_items.content`、`conversation_turns.content`、`memory_facts.fact_value` 全部明文 SQLite，数据文件一旦被复制即裸奔。没有任何 PII 识别、redaction、导出或删除接口。

**推荐**：
1. 短期：`better-sqlite3` 支持 SQLCipher 扩展，可用 `better-sqlite3-sqlcipher` + `SQLITE_KEY` 环境变量实现静态加密；密钥从 macOS Keychain 或 `~/.config/wi-chat/key` 读取，不进 `.env`；
2. 中期：`POST /api/assistants/:id/forget` 接口——软删 memory_items + 覆写 content 为 `[redacted]`，保留 id 不破坏 outbox/vector 引用链；
3. 长期：在 memoryIngestService 里接入 `presidio`（Python）或 `gliner-js` 做 NER，自动 mask 手机号/身份证/银行卡。

**工作量**：短期 S，中期 M，长期 L

**阻塞下游**：个人敏感数据（家庭成员、工作信息、位置）一旦泄漏不可逆。

---

## P1 — 影响稳定性或中期可扩展

### P1-1：LLM provider 无抽象层，硬绑 Qwen/本地 endpoint

**缺口**：6 个 service 直接 `fetch(config.qwenBaseUrl + '/chat/completions')`，切换到 GPT/Claude/Ollama 需要改 6 处代码。`langchainQwenService.js` 用了 LangChain 封装，但其他地方没用。

**推荐**：把 6 处 `callLlm*` 函数提取成 `src/services/llmProvider.js`，export 一个 `callChat({ messages, maxTokens, temperature })` 函数，内部按 `LLM_PROVIDER=openai|anthropic|local` 分支路由，统一处理重试和 token 计数。原有的 `fetchWithTimeout` 保留在 provider 内部。

**工作量**：M（4-6h）

**阻塞下游**：本地 LLM 不可用时无法热切换云端 fallback。

---

### P1-2：无 LLM token 消耗统计，cost 盲区

**缺口**：每次 LLM 调用消耗多少 token 没有记录。`character_behavior_journal.result_json` 里也没有 prompt_tokens / completion_tokens。使用云端 API 时账单不可预期。

**推荐**：
1. `callLlmForPlanDraft`/`callLlmForCatchup` 等函数解析 response body 的 `usage.prompt_tokens` / `usage.completion_tokens`，写入 `character_behavior_journal.result_json`；
2. 新增 `llm_cost_log` 表或在 admin metrics 接口暴露 `SELECT SUM(prompt_tokens), SUM(completion_tokens) FROM character_behavior_journal WHERE created_at > ?`。

**工作量**：S（2-3h）

**阻塞下游**：成本感知、rate limit 预判、token budget 控制。

---

### P1-3：无结构化观察性，错误追踪靠 console.log

**缺口**：所有日志是 `console.log/error`，进 PM2 out/error.log 后只能 grep，没有 structured JSON 日志、没有 request tracing ID、没有 Sentry/等错误聚合。`character_behavior_journal` 记录了任务级别信息，但 HTTP 请求层面完全不可观测。

**推荐**：
1. 引入 `pino`（S）替换 console，结构化 JSON 输出，PM2 用 `pm2-logrotate` 已安装；
2. 给 HTTP 请求中间件加 `x-request-id`（可用 uuid v4），透传到日志；
3. 中期：Sentry Node.js SDK（M），只需 `Sentry.init()` + express error handler，捕获 unhandled rejection。

**工作量**：S-M

**阻塞下游**：生产环境问题排查全靠猜。

---

### P1-4：多设备 / 跨端 session 一致性边界不清晰

**缺口**：`sync/push` 支持多设备写入（通过 `deviceId` 区分），但 `conversation_turns` 没有 `device_id` 字段，无法追溯哪条 turn 来自哪个设备。`sync/state` 接口的 `deviceId` 参数"当前不影响结果，仅作预留"（见 README）。多端同时在线时，同一 sessionId 可能收到两个设备的 turn 交错插入。

**推荐**：
1. `conversation_turns` 加 `device_id TEXT` 列（migration 011）；
2. `syncIngestService` 写 turn 时带上 `deviceId`；
3. `sync/state` 实现真正的 per-device 状态（`lastTurnAt WHERE device_id = ?`）。

**工作量**：M（1-2天，需 migration + API 更新）

**阻塞下游**：多设备同时使用时无法 replay 或 audit 某设备的对话流。

---

### P1-5：备份策略手动，无自动化

**缺口**：`npm run backup:monthly` 脚本存在，但需要手动触发。没有定期自动备份 cron，没有备份完整性校验，没有异地备份。DB 文件 4.1MB 已有 5 个手动备份快照，说明历史上有几次手动备份点。

**推荐**：
1. 在 `scheduler.js` 加一个 `retentionSweep` 级别的 backup cron（默认 `0 2 * * 0` 每周日凌晨）；
2. 备份后用 `sqlite3 db.bak .dump | sha256sum` 验证完整性，写 backup_manifest.json；
3. 有 LAN 存储或 NAS 的情况下，用 `rsync` 推一份到 NAS（配置 `BACKUP_REMOTE_PATH`）。

**工作量**：S（3-4h）

**阻塞下游**：磁盘故障 / 意外 DROP 时数据不可恢复。

---

### P1-6：WAL 模式下 checkpoint 累积风险

**缺口**：`wal_autocheckpoint = 1000`（pages），SQLite WAL 文件会在超过 1000 pages 写入后自动 checkpoint。但若进程突然 kill 时正在 checkpoint，恢复时 WAL 文件可能残留。目前没有进程退出时的主动 checkpoint 调用。

**推荐**：在 `gracefulExit` 里 `wsShutdown()` 之后加 `db.pragma('wal_checkpoint(TRUNCATE)')` 主动清 WAL，减少下次启动时的恢复时间。需要先 `require('../db')` 可用。

**工作量**：S（1h）

**阻塞下游**：长期运行后 WAL 文件积累，影响启动速度和磁盘占用。

---

### P1-7：角色档案无成长/状态机，character_background 是静态文本

**缺口**：`assistant_profile.character_background` 是一段静态文字，没有结构化的"角色状态"（情绪值、关系亲密度阶段、最近发生的标志性事件）。`familiarity` 是一个线性数字，无法表达关系的质变（陌生人→熟人→密友）。

**推荐**：
1. 新增 `assistant_state_ext` 表（migration），存储 `mood TEXT, relationship_stage TEXT, last_milestone_at INT, milestone_summary TEXT`；
2. `lifeMemoryService` 在写记忆时同步更新 `mood`（从 LLM response 抽取情绪标签）；
3. `familiarity` 改为枚举阶段（0: stranger, 1: acquaintance, 2: friend, 3: close），达到阈值自动升级，触发一次 plan 生成（relation_milestone trigger）。

**工作量**：L（3-5天）

**阻塞下游**：角色行为缺乏动态感，无法根据关系阶段调整话术和主动消息频率。

---

## P2 — 增强体验、未来扩展

### P2-1：测试覆盖率近零

**缺口**：整个 `src/` 没有 `*.test.js` 或 `*.spec.js`。没有 jest/vitest 配置。cron 任务、outbox 幂等、sync 端到端均无自动化测试。`scripts/sync-replay.js` 是手动集成测试脚本，不能在 CI 中运行。

**推荐**：
1. 引入 `vitest`（比 jest 轻，支持 ESM）；
2. 优先覆盖：`syncIngestService`（幂等 + clock_corrected）、`memoryRetrievalService`（评分公式）、`proactivePlanService.evaluateAllTriggers()`；
3. 用 `better-sqlite3` in-memory DB（`:memory:`）做 fixture，不需要 mock；
4. 时间依赖的测试（cron trigger、recency score）用 `vi.setSystemTime()` mock。

**工作量**：M per module，L for full coverage

**阻塞下游**：重构时无法快速验证正确性，CI 无法接入。

---

### P2-2：无用户偏好向量 / 个性化检索

**缺口**：所有角色共用同一套检索参数（topK、window_days）。没有"用户偏好向量"——即把用户高频提及的主题聚合成一个长期向量，用于 plan 生成时的相关性 boost。

**推荐**：每周跑一次 `user_profile_embedder`：把 `memory_facts` 的 top-30 fact_value embed 后做平均，存为 `assistant_profile.user_preference_vector BLOB`，在 `retrieveMemory` 里加 0.05 权重的偏好对齐分。

**工作量**：M

---

### P2-3：media / 附件支持缺失

**缺口**：`conversation_turns.content` 是纯文本，无法记录图片/语音/文件。随着 Android 端发展，用户会发送媒体消息，目前这些会被丢弃或存为空字符串。

**推荐**：新增 `turn_attachments` 表（turn_id, media_type, uri, thumbnail_uri, metadata_json），`content` 保留文本摘要，media 单独存储。URI 指向本地 `data/media/` 或远程 CDN。

**工作量**：L

---

### P2-4：Qdrant 依赖残留（`@qdrant/js-client-rest`）

**缺口**：`package.json` 的 `dependencies` 里仍有 `@qdrant/js-client-rest: ^1.17.0`，但代码中已没有任何 `require('qdrant')` 引用。增加安装时间，混淆依赖图。

**推荐**：`npm uninstall @qdrant/js-client-rest`，commit 一行清理。

**工作量**：S（10分钟）

---

### P2-5：WebSocket 无 reconnect 背压控制

**缺口**：WS 连接断线重连后，`flushPendingForUser` 一次性发送所有积压消息（最多 50 条），客户端可能来不及处理。没有消息 rate limit 或分批发送。

**推荐**：`flushPendingForUser` 改为分批发送（每次 10 条），两批之间 setImmediate 让出事件循环；或在帧里加 `batchIndex` / `totalBatches` 让客户端控制 ACK 节奏。

**工作量**：S

---

### P2-6：Plan 触发器仅 2 种，缺"承诺跟进"和"周年/生日"

**缺口**：`proactivePlanService.evaluateAllTriggers()` 只实现了 `inactive_7d` 和 `daily_greeting`，代码里有两条 `TODO Phase B+` 注释：`followup_promise`（从对话中提取跟进钩子）和 `birthday_or_anniversary`（从 memory_facts 中扫描日期型 key）。

**推荐**：
1. `followup_promise`：在 `memoryIngestService` 里用正则检测 "明天/下周/到时候告诉我" 等承诺表达，插入 `memory_facts(fact_key='followup_promise', fact_value='xxx', confidence=0.8)`；plan evaluator 扫描这类 fact 生成 trigger。
2. `birthday_or_anniversary`：扫描 `memory_facts WHERE fact_key LIKE '%生日%' OR fact_key LIKE '%anniversary%'`，计算下次触发距今天数。

**工作量**：M per trigger

---

## 缺口总览

| 编号 | 一句话定义 | 优先级 | 工作量 | 阻塞什么 |
|------|-----------|--------|--------|---------|
| P0-1 | embedding 无降级，endpoint 挂则记忆不可检索 | P0 | M | 所有记忆检索 |
| P0-2 | 向量检索 O(n) 全表扫，规模化必崩 | P0 | M | 长期记忆性能 |
| P0-3 | 记忆 PII 明文存储，无加密无删除接口 | P0 | M-L | 数据安全合规 |
| P1-1 | LLM provider 硬绑，无抽象无热切换 | P1 | M | 云端 fallback |
| P1-2 | LLM token 消耗无统计 | P1 | S | 成本控制 |
| P1-3 | 无结构化日志无错误聚合 | P1 | S-M | 生产排障 |
| P1-4 | 多设备 turn 无 device_id 追溯 | P1 | M | 多端一致性 |
| P1-5 | 备份无自动化 | P1 | S | 数据可恢复性 |
| P1-6 | WAL checkpoint 未主动清理 | P1 | S | 长期运行稳定性 |
| P1-7 | 角色无状态机，关系是静态数字 | P1 | L | 角色动态感 |
| P2-1 | 测试覆盖率近零 | P2 | M-L | CI/重构安全性 |
| P2-2 | 无用户偏好向量 | P2 | M | 个性化检索 |
| P2-3 | 无媒体/附件支持 | P2 | L | 多媒体对话 |
| P2-4 | Qdrant 依赖残留 | P2 | S | 依赖整洁 |
| P2-5 | WS flush 无背压控制 | P2 | S | 重连稳定性 |
| P2-6 | Plan 触发器仅 2 种 | P2 | M | 主动推送多样性 |
