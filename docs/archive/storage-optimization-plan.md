# 长期本地化存储优化方案（10 年存档目标）

## 背景

当前服务采用 SQLite-first 架构（见 [ADR-0001](adr/0001-sqlite-first-memory-architecture.md)），单文件 `data/character-behavior.db` 承载所有用户对话、角色记忆、自驱行为日志、向量索引。目标改为：**保留全部个人/角色数据 10+ 年，控制总占用并保证可检索可恢复**。

## 容量评估（基于实测 1.5 天数据外推）

| 用量 | 现状 / 年 | 优化后 / 年 | 10 年优化后 |
|------|-----------|-------------|-------------|
| 轻度（80 轮/日） | ~700 MB | ~80 MB | ~1 GB |
| 中度（200 轮/日） | ~1.8 GB | ~200 MB | ~2.5 GB |
| 重度（500 轮/日） | ~4.5 GB | ~500 MB | ~5 GB |

主要膨胀来自三处：`vector_json`（占库 53%）、双写 `interaction_log`、`outbox_events.payload_json` 内的内容副本。

## 表的长期分类

数据按"是否属于个人/角色档案"分三档，决定保留策略：

### 一档：永久保留（用户与角色的人生记录）

- `conversation_turns` — 每一句对话原文
- `memory_items` — 提炼记忆（含 `life_event` / `work_event`，即 AI 角色自己模拟的生活记忆）
- `memory_facts` / `memory_edges` — 偏好与时序图
- `assistant_profile` / `character_state` — 人设与熟悉度

### 二档：永久保留但列级瘦身（角色自驱行为档案）

- `character_behavior_journal`（原 `autonomous_run_log`，阶段 1 内重命名）— AI 在每个 cron tick 思考过的内容，包括驳回的 draft、`message_intent`、`reason`、`should_persist/should_initiate` 决策。这是**角色"想过什么但没说出口"的历史**，10 年后能用来回看角色性格演化。

  **策略**：保留行不删，但 90 天后清空 `input_json` / `result_json` 两个大字段（可由 `recentTurns` + `recentMemories` 重放），留 `run_type, assistant_id, session_id, should_persist, should_initiate, status, reason, message_intent, draft_message, error_message, created_at`。压缩后单行 ~80 B，10 年约 300 MB。

### 三档：短期保留（运行时调试 / 审计）

| 表 | 保留期 | 之后处理 |
|----|--------|----------|
| `memory_retrieval_log` | 30 天 | 直接删 |
| `outbox_events` (status='consumed') | 7 天 | 直接删 |
| `local_outbox_messages` (acked) | 30 天 | 直接删 |
| `dead_letter_events` | 永久 | 但超 1000 条告警 |
| `interaction_log` | — | **整表 drop**（与 `conversation_turns` 重复） |

---

## 阶段 1：数据卫生 + 自驱行为档案策略

> 一个 subagent 完成。无破坏性数据变更，全部可回滚。

### 目标

- 消除 `conversation_turns` / `interaction_log` 的双写
- `outbox_events.payload_json` 瘦身
- 重命名 `autonomous_run_log` → `character_behavior_journal`
- 引入 `character_behavior_journal` 的列级裁剪（保结构）
- 引入 retention sweep cron，处理三档短期表
- 打开外键 + 调优 PRAGMA

### 涉及文件

- `src/db/migrations/006_storage_hygiene.sql`（新增）
- `src/db.js`（PRAGMA、删 `interaction_log` 相关查询）
- `src/services/memoryIngestService.js`（瘦身 outbox payload）
- `src/services/lifeMemoryService.js`（同上）
- `src/workers/memoryIndexer.js`（消费时 JOIN 取内容，不再依赖 payload）
- `src/workers/retentionSweeper.js`（新增）
- `src/scheduler.js`（注册新 cron）
- `src/routes/api.js`（`getRecentAssistantInteractions` 改读 `conversation_turns`）
- `scripts/db-query.js`（去除 `--table interaction_log`）
- `src/config.js`（新增 retention 相关配置）

### 步骤

1. **新 migration `006_storage_hygiene.sql`**：
   - `DROP TABLE interaction_log;`
   - `ALTER TABLE autonomous_run_log RENAME TO character_behavior_journal;`
   - `DROP INDEX IF EXISTS idx_autonomous_run_log_type_created;`
   - `DROP INDEX IF EXISTS idx_autonomous_run_log_assistant_created;`
   - `CREATE INDEX IF NOT EXISTS idx_behavior_journal_type_created ON character_behavior_journal(run_type, created_at DESC);`
   - `CREATE INDEX IF NOT EXISTS idx_behavior_journal_assistant_created ON character_behavior_journal(assistant_id, created_at DESC);`
   - `CREATE INDEX IF NOT EXISTS idx_behavior_journal_created ON character_behavior_journal(created_at);`
   - `CREATE INDEX IF NOT EXISTS idx_outbox_status_consumed ON outbox_events(status, updated_at);`
   - `CREATE INDEX IF NOT EXISTS idx_local_outbox_acked ON local_outbox_messages(status, acked_at);`

2. **`src/db.js` PRAGMA**：在 `runMigrations` 之前加：
   ```js
   db.pragma("foreign_keys = ON");
   db.pragma("synchronous = NORMAL");
   db.pragma("mmap_size = 268435456");
   db.pragma("cache_size = -65536");
   db.pragma("wal_autocheckpoint = 1000");
   ```

3. **删除 `interaction_log` 双写**：
   - `src/routes/api.js` 中 `report-interaction` 路由删掉那条 `INSERT INTO interaction_log` SQL
   - `src/db.js` 中 `getRecentAssistantInteractions` / `getLastAssistantInteractionAt` 改 SELECT `conversation_turns`，字段同名直接替换
   - `scripts/db-query.js` 删除 `interaction_log` 分支

4. **outbox payload 瘦身**：
   - `memoryIngestService.js` 与 `lifeMemoryService.js` 的 `insertOutboxEvent({ payload })` 只保留 `{ memoryId }`
   - `workers/memoryIndexer.js` 消费时改为 `SELECT content, assistant_id, session_id, created_at FROM memory_items WHERE id = ?`

5. **`src/workers/retentionSweeper.js`**（新文件）：导出 `runRetentionSweepOnce()`，单事务批量执行：
   ```sql
   DELETE FROM memory_retrieval_log WHERE created_at < :now - 30d;
   DELETE FROM outbox_events WHERE status='consumed' AND updated_at < :now - 7d;
   DELETE FROM local_outbox_messages WHERE status='acked' AND acked_at < :now - 30d;
   UPDATE character_behavior_journal
     SET input_json='{}', result_json='{}'
     WHERE created_at < :now - 90d
       AND (length(input_json) > 2 OR length(result_json) > 2);
   ```
   末尾 `db.exec("PRAGMA wal_checkpoint(TRUNCATE)")`，每月 1 号再额外执行 `VACUUM`。

6. **`src/scheduler.js`**：新增每日 03:30 cron `RETENTION_SWEEP_CRON`，复用 `schedulerLockService` 拿锁，调用 `runRetentionSweepOnce`。

7. **`src/config.js` + `.env.example`**：
   ```
   RETENTION_SWEEP_CRON=30 3 * * *
   RETENTION_SWEEP_LOCK_NAME=retention_sweep_tick
   RETENTION_RETRIEVAL_LOG_DAYS=30
   RETENTION_OUTBOX_CONSUMED_DAYS=7
   RETENTION_LOCAL_ACKED_DAYS=30
   BEHAVIOR_JOURNAL_PRUNE_DAYS=90
   ```

8. **`package.json`** 加脚本：
   ```
   "retention:run": "node -e \"require('./src/workers/retentionSweeper').runRetentionSweepOnce().then(r=>console.log(JSON.stringify(r,null,2)))\""
   ```

### 验收

- `npm run setup && npm run dev` 启动无错
- `npm run retention:run` 输出每张表删除/裁剪行数 JSON
- `sqlite3 data/character-behavior.db ".tables"` 不再包含 `interaction_log`
- `npm run db:query -- --table outbox_events --limit 1 --json` 显示 payload 仅含 `{"memoryId":"..."}`
- 调一次 `/api/report-interaction`，确认 `conversation_turns` / `memory_items` / `outbox_events` 都按预期写入

### 回滚

- 所有变更走新 migration，回滚 = checkout 上一版 + 不再调用 `retention:run`
- `interaction_log` drop 之前应在 PR 描述中明确："如需恢复历史，从 `data/character-behavior.db` 备份 dump 中取"

---

## 阶段 2：向量列从 JSON 切到 BLOB

> 一个 subagent 完成。**带数据迁移，需要先备份 DB**。

### 目标

把 `memory_vectors.vector_json TEXT` 替换成 `vector_blob BLOB`，单行 5310 B → ~1024 B（256 维 float32），整库占用预计下降 40%+。

### 涉及文件

- `src/db/migrations/007_vector_blob.sql`（新增）
- `src/services/vectorProviders/sqliteVectorStore.js`
- `src/services/vectorProviders/hnswSidecarStore.js`（如果它也读 `memory_vectors`）
- `scripts/migrate-vectors-to-blob.js`（新增一次性脚本）
- `package.json`

### 步骤

1. **`007_vector_blob.sql`**：
   ```sql
   ALTER TABLE memory_vectors ADD COLUMN vector_blob BLOB;
   ```
   不在 migration 里 drop `vector_json`，避免 migration 不可重入。

2. **新写入路径用 BLOB**：
   - `sqliteVectorStore.js` 写入：`Buffer.from(new Float32Array(vec).buffer)`，列名 `vector_blob`
   - 读取：`new Float32Array(row.vector_blob.buffer, row.vector_blob.byteOffset, row.vector_blob.byteLength / 4)`
   - 兼容期内 `SELECT vector_blob, vector_json FROM memory_vectors`，`vector_blob` 为 NULL 时回退 JSON 解析

3. **`scripts/migrate-vectors-to-blob.js`**：
   - 备份提示：脚本入口先 `console.log` 提醒 `cp data/character-behavior.db data/character-behavior.db.bak.$(date +%s)`
   - 分批 `SELECT memory_item_id, vector_json FROM memory_vectors WHERE vector_blob IS NULL LIMIT 500`
   - 解析 JSON → Float32Array → BLOB，事务批量 `UPDATE`
   - 完成后输出 `done <n>，剩余 0 行待迁移`

4. **`package.json`**：
   ```
   "vectors:backfill": "node scripts/migrate-vectors-to-blob.js"
   ```

5. **第二个 migration `008_vector_blob_finalize.sql`（在阶段 2 收尾、`vectors:backfill` 跑完之后再合并）**：
   ```sql
   ALTER TABLE memory_vectors DROP COLUMN vector_json;
   ```
   （SQLite 3.35+ 支持 `DROP COLUMN`，better-sqlite3 12 默认携带新版）

### 验收

- `npm run vectors:backfill` 输出 `剩余 0 行`
- `sqlite3 data/character-behavior.db "SELECT typeof(vector_blob) FROM memory_vectors LIMIT 1;"` 返回 `blob`
- 调一次 `/api/tool/memory-context`，向量召回正常返回 `memories[]`
- 库体积 `du -h data/character-behavior.db` 明显下降
- 阶段收尾后 `vector_json` 列不存在

### 回滚

- 阶段 2 第 5 步合并前若发现问题：直接保留 `vector_json` 不删，读路径回退 JSON
- 已经 drop column：从备份恢复

---

## 阶段 3：长期存档能力（FTS5 + 年度归档 + 备份脚本 + 导出工具）

> 一个 subagent 完成。可拆成三个独立 PR，互不阻塞。

### 目标

- 让 10 年后能搜得到任意一句话
- 让主库永远只有近 1–2 年热数据
- 让备份是一条命令的事
- 让单个角色的数据可以一键导出 / 迁移

### 涉及文件

- `src/db/migrations/009_fts5.sql`
- `src/db.js`（导出 FTS 同步触发器和搜索函数）
- `src/routes/api.js`（新增 `POST /api/search`）
- `scripts/archive-year.js`
- `scripts/backup.js`
- `scripts/export-assistant.js`
- `package.json`

### 步骤

#### 3.1 FTS5

1. **`009_fts5.sql`**：
   ```sql
   CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
     content, assistant_id UNINDEXED, session_id UNINDEXED, role UNINDEXED,
     content='conversation_turns', content_rowid='rowid',
     tokenize='unicode61 remove_diacritics 2'
   );
   CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
     content, assistant_id UNINDEXED, memory_type UNINDEXED,
     content='memory_items', content_rowid='rowid',
     tokenize='unicode61 remove_diacritics 2'
   );
   -- INSERT/UPDATE/DELETE 三个 trigger 同步两张主表
   -- 一次性 INSERT INTO ..._fts(rowid, content, ...) SELECT rowid, ... FROM 主表
   ```
   注：`conversation_turns.id` 是 TEXT UUID，不是 rowid，FTS 用隐式 rowid 即可，搜索结果再 JOIN 回主表拿 UUID。

2. **`src/db.js`** 导出 `searchConversation({ assistantId, q, limit })` / `searchMemory(...)`：
   ```sql
   SELECT t.id, t.role, t.content, t.created_at, bm25(conversation_turns_fts) AS score
   FROM conversation_turns_fts f
   JOIN conversation_turns t ON t.rowid = f.rowid
   WHERE f.content MATCH ? AND f.assistant_id = ?
   ORDER BY score
   LIMIT ?
   ```

3. **`POST /api/search`**：body `{ assistantId, q, scope: "conversation"|"memory"|"both" }`，返回 hits。

#### 3.2 年度归档

`scripts/archive-year.js`：

```
node scripts/archive-year.js --year 2025
```

- 在 `data/archive/` 下生成 `archive-2025.db`
- 用 `VACUUM INTO 'data/archive/archive-2025.db'` 拷贝主库 schema
- 主库 ATTACH archive，按 `created_at` 区间把 `conversation_turns` / `memory_items` / `memory_facts` / `memory_edges` / `character_behavior_journal` 拷贝过去，再从主库删除
- archive DB 跑一次 `VACUUM`、文件 `chmod 444`
- 主库再 `VACUUM`
- 输出归档行数与文件大小

调用：手动每年 1 月跑一次。**先在 `--dry-run` 模式跑一遍输出待归档行数**。

#### 3.3 备份（按月增量，按需手动触发）

用户当前不需要每日全量备份。改为月度增量：

`scripts/backup.js`，支持子命令：

- `monthly`：导出**自上次备份以来新增的对话/记忆/行为档案**到 `data/backup/incr-YYYY-MM.jsonl.gz`
  - 用 `data/backup/.last_backup_at` 文件记录上次成功备份的 `created_at` 时间戳
  - 涉及表：`conversation_turns`、`memory_items`、`memory_facts`、`memory_edges`、`character_behavior_journal`、`assistant_profile`（profile 是低频改动，全量也只有几行）
  - 每张表单独一个 JSONL 段，行格式 `{"_table":"<table>", ...row}`
  - 完成后写入新的 `.last_backup_at`
- `verify <file>`：`gzip -t` + 解压抽样校验首尾各 5 行 JSON 可解析

`package.json`：
```
"backup:monthly": "node scripts/backup.js monthly"
```

异地备份前用 `age -p` / `gpg -c` 加密。系统盘加密（FileVault / BitLocker）作为本地兜底。

#### 3.4 导出

`scripts/export-assistant.js`：

```
node scripts/export-assistant.js --assistant <id> --out exports/<id>.jsonl
```

- 一行一条记录，JSONL 格式
- 包含 `assistant_profile`、所有 `conversation_turns`、`memory_items`、`memory_facts`、`memory_edges`、`character_behavior_journal`（裁剪后字段）
- 包含 `archive/*.db` 中匹配该 assistant 的全部历史

### 验收

- `POST /api/search { q: "咖啡" }` 在测试数据上返回非空 hits
- `node scripts/archive-year.js --year 2025 --dry-run` 输出每张表行数预览
- `npm run backup:daily` 在 `data/backup/` 留下当天 `.sql.gz`
- `npm run backup:snapshot` 留下 `.db` 快照，`scripts/backup.js verify` 通过 integrity_check
- `node scripts/export-assistant.js --assistant <demo>` 产出可读 JSONL，行数 = `conversation_turns + memory_items + ...`

---

## 全局风险与注意事项

1. **每个阶段开始前 `cp data/character-behavior.db data/character-behavior.db.bak.<ts>`**。脚本里也会提醒。
2. **不要在阶段 2 完成前部署到生产用机**。BLOB 写入路径如果误用 JSON.stringify 会损坏数据。
3. **`character_behavior_journal` 的 `input_json/result_json` 裁剪是不可逆的**。第一次跑前先 dump 一份完整的 `character_behavior_journal` 到归档目录。
4. **每个阶段单独提 PR**，不要混合。出问题时回滚成本最小。
5. 三阶段都跑完后，`docs/adr/0002-long-term-archive.md` 补一篇 ADR 记录决策。

## Subagent 执行入口

每个阶段都是自包含的 brief，可直接交给 general-purpose subagent，按顺序执行：

1. 阶段 1 brief → 见上文「阶段 1」
2. 阶段 2 brief → 见上文「阶段 2」（前置：阶段 1 已合并）
3. 阶段 3 brief → 见上文「阶段 3」（前置：阶段 2 已合并）
