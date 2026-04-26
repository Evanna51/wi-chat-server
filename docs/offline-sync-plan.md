# 离线对话同步方案（chatbox-Android ↔ wi-chat-server）

## 背景

现状：每条对话由 chatbox-Android 实时调 `POST /api/report-interaction` 写到服务端。

问题：用户在户外（不在家中 WiFi 下）时，Android 客户端无法访问服务。这段时间产生的对话堆在手机本地，没进服务端 SQLite，记忆抽取/向量索引/角色行为日志都断档。回到家后，**需要把这批离线对话补回服务端，并触发对应的记忆派生**。

目标：每天定时一次 + 进入家中 WiFi 时自动触发，幂等增量推送，0 数据丢失，0 重复。

## 核心心智模型（先理解这个，剩下都是细节）

- **客户端生成 UUID v7 作为 turn id**，包含时间戳前缀，天然有序
- **服务端 `conversation_turns.id` 是 PK**，写入用 `INSERT OR IGNORE`
- 同一条 turn 上传 N 次 = 第 1 次写入，第 2..N 次自动忽略
- 手机本地维护一个 outgoing 队列（一张表加 `synced` 列），同步成功后置位
- 不需要版本号、不需要 vector clock、不需要 CRDT
- 时间戳用手机的 `createdAt`，**信任手机本地时钟**（误差可接受，记忆抽取不依赖毫秒精度）

把这套放到位之后，"在户外的消息回家后同步"就只是"phone 拿出 synced=0 的行批量 POST，server 幂等吃掉"两步。

## 关键决策

| 问题 | 决策 | 理由 |
|------|------|------|
| Source of truth | 谁先产生谁是 SoT，phone 离线时 phone 是 SoT | 离线时 phone 是唯一在线设备，无歧义 |
| 去重 key | client-generated UUID v7 | 主键级别去重，最简单 |
| 时间戳 | phone 的 `createdAt`，毫秒 unix | 这条对话发生在 phone 上，phone 知道何时 |
| 同步触发 | 每日 WorkManager + 进入家中 WiFi 自动 + 手动按钮 | 三层兜底 |
| 网络判定 | 直接 `GET /api/health` 探活，2 秒超时 | 比 SSID 检测可靠，无定位权限要求 |
| 批量大小 | 每批 100 条 turns | 跟前端分页一致，request body 受控 |
| 失败处理 | phone 端 `synced` 列保持 0，下次重试 | 简单 |
| session_id 多设备冲突 | phone 用 `<deviceId>-<uuid>` 作 session 前缀 | 避免两台手机的 session 撞名 |
| online 路径 | 保留现有 `/api/report-interaction` | 低延迟单条上报体验不变 |
| offline drain 路径 | 走新接口 `/api/sync/push` | 幂等 + 批量 |

长期可以让 phone **统一只用 `/api/sync/push`**（每条对话产生时立即触发一次单条 batch），代码路径统一，但短期不强制。

## 服务端契约

### POST /api/sync/push（新增）

**请求**：
```json
{
  "deviceId": "android-001",
  "turns": [
    {
      "id": "019dca12-3b4c-7890-abcd-1234567890ab",
      "assistantId": "...",
      "sessionId": "android-001-xxx",
      "role": "user",
      "content": "...",
      "createdAt": 1777200000000
    }
  ]
}
```

**响应**：
```json
{
  "ok": true,
  "accepted": 47,
  "skipped": 3,
  "rejected": 0,
  "details": [
    { "id": "...", "status": "accepted" },
    { "id": "...", "status": "skipped", "reason": "already_exists" },
    { "id": "...", "status": "rejected", "reason": "invalid_role" }
  ]
}
```

**语义**：
- 单事务处理整批
- 每条：先 `SELECT id FROM conversation_turns WHERE id=?`
  - 命中 → `skipped: already_exists`（幂等）
  - 未命中 → 走 `ingestInteraction` 的完整路径（写 turn + memory_item + facts + edge + outbox）
- `assistantId` 不存在的允许写入（角色由 phone 创建），server 不强约束 `assistant_profile`
- 边界：`turns.length` 限制 ≤ 200，超了 400 错误（强制 phone 拆批）
- 时间戳：直接用客户端的 `createdAt`，不重写

### GET /api/sync/pull（复用现有接口）

phone 已经在用 `GET /api/pull-messages?since=<ts>` 拉 server 在它离线期间生成的 proactive 消息。**不需要新接口**。

### GET /api/sync/state（新增，可选）

```
GET /api/sync/state?deviceId=android-001&assistantId=xxx
```

**响应**：
```json
{
  "ok": true,
  "serverTurnCount": 12345,
  "lastServerTurnAt": 1777200000000,
  "lastSyncAt": 1777199000000
}
```

phone 用来自检"我本地有没有比 server 还多的东西"。**v1 不必做**，等真的需要再说。

## 服务端改造点

### 1. `src/db.js`：`insertConversationTurn` 接受可选 `id`

```js
function insertConversationTurn({ id, assistantId, sessionId, role, content, createdAt = Date.now() }) {
  const turnId = id || uuidv7();
  // ... 写入用 turnId
  return turnId;
}
```

向后兼容：现有 `report-interaction` 不传 `id`，行为不变。

### 2. `src/services/memoryIngestService.js`：幂等化

`ingestInteraction` 当前每次都 INSERT，离线 push 重试可能产生重复 `memory_items`。改造：

```js
function ingestInteraction({ turnId, ... }) {
  // 1. INSERT OR IGNORE conversation_turns —— 通过 db.js 改造后的版本完成
  // 2. 检查 memory_items 是否已有 source_turn_id=turnId 的行，有就直接 return 现有 memoryId
  // 3. 否则正常 insert memory_items + facts + edges + outbox
}
```

注意：`life_event` / `work_event` 那条路径用 `auto-life:<uuid>` 作 source_turn_id，每次都 unique，不受影响。

### 3. 新增 `src/routes/sync.js`

```js
router.post("/push", authMiddleware, (req, res) => {
  // zod 校验 body
  // 单事务循环：跳过已存在的 turn id；新行走 ingestInteraction
  // 返回 details 数组
});
```

挂到 `src/index.js`：`app.use("/api/sync", syncRouter)`。

### 4. memory_edges 时序

在批量场景下，按 `createdAt ASC` 顺序处理每条，"上一条 memory" 自然是刚插入的同 batch 前一条（已写库）。现有 ingestInteraction 的 SELECT prev 逻辑就对：

```sql
SELECT id FROM memory_items
WHERE assistant_id = ? AND session_id = ? AND id != ?
ORDER BY created_at DESC LIMIT 1
```

只要批内 createdAt 不撞，结果就对。phone 上一条对话和 server 上同 session 已有对话之间的 edge 也会自然产生。无需额外改造。

## phone 端落地（chatbox-Android 项目工作）

这部分**不在本仓库范围**，但写在这里给 chatbox-Android 一个对接清单。

### Android 端必备改动

1. **本地 Room/SQLite 加 `pending_sync_turns` 表**（或在现有 chat 表加 `synced` INTEGER 列）：
   ```
   id (UUID v7, generated client-side via androidx.uuid 或自实现)
   assistant_id, session_id, role, content, created_at
   synced INTEGER DEFAULT 0
   sync_attempts INTEGER DEFAULT 0
   last_attempt_at INTEGER
   ```

2. **每条对话产生时**：写本地表，`synced=0`；如果当前在线，立即触发同步（单条 batch）

3. **WorkManager 周期任务**（每天 1 次）：
   - 拿出 `synced=0` 全部行
   - 按 100 一批切
   - 对每批 POST `/api/sync/push`
   - 成功的根据 response.details 把 `synced=1`
   - 失败的 `sync_attempts++`，设 `last_attempt_at`

4. **进入家中 WiFi 自动触发**：
   - 注册 `ConnectivityManager.NetworkCallback`
   - 每次网络变化时跑 `GET /api/health`，2s 超时
   - 200 → 触发同步队列 drain

5. **session_id 命名规范**：`<deviceId>-<uuid4>` 或 `<deviceId>-<timestamp>`，避免多设备同 user 撞 session

6. **UUID v7 生成**：Java/Kotlin 没标准库，用第三方（如 `com.github.f4b6a3:uuid-creator`）或自实现（48-bit ms timestamp + 12-bit rand + 62-bit rand）

### Android 不需要做的

- 不需要本地复制 server 的记忆/向量数据
- 不需要本地实现记忆检索（继续走 `/api/tool/memory-context` 实时调）
- 不需要双向 diff

## Phase 划分

### Phase 1：服务端 sync push（半天）

#### 涉及文件
- `src/routes/sync.js`（新）
- `src/services/syncIngestService.js`（新）—— 暴露 `ingestTurnsBatch({ turns })`
- `src/services/memoryIngestService.js`（改 —— 幂等）
- `src/db.js`（改 —— `insertConversationTurn` 支持外部 id；导出新查询函数）
- `src/index.js`（挂路由）
- `scripts/sync-replay.js`（新）—— 模拟手机 push N 条用于测试
- `package.json`（新 script `sync:replay`）
- `README.md`（新增 "Sync API" 一节）

#### 验收（subagent brief 要点）
1. `npm run check` ok
2. 起服务后 POST `/api/sync/push` 一批 5 条新 turn → response `accepted=5`
3. 同样 payload 再 POST 一次 → `skipped=5, accepted=0`
4. 推送一条空 content / role 不合法 → 单条 `rejected`，其它 `accepted`
5. 推送后 server 端 `memory_items WHERE source_turn_id IN (...)` 数量 = 5（幂等）
6. 推送后 outbox 走 indexer，向量入库
7. `scripts/sync-replay.js --assistant smoke --count 50` 一键造 50 条同步测试

### Phase 2：sync state 自检接口（可选，跳过到真有需求）

### Phase 3：chatbox-Android 端（另一个 repo）

照上面 "phone 端落地" 清单实现。本仓库不做，但 README 写清楚契约让对面 PR 时有参考。

### Phase 4：端到端测试

模拟流程：
1. 关掉服务（模拟 phone 出门）
2. `node scripts/sync-replay.js --offline-buffer ...` 生成本地 buffer JSON
3. 重启服务（回到家）
4. `node scripts/sync-replay.js --drain-buffer <file>` push 进 server
5. 校验：
   - `conversation_turns` 增加 N 条
   - `memory_items` 增加 N 条（source_turn_id 全部对得上）
   - `memory_vectors` 最终一致（等 indexer 跑完）
   - `character_behavior_journal` 不受影响
6. 重复 step 4 → `accepted=0, skipped=N`（验证幂等）

## 风险与边界

1. **批量 ingest 期间，定时调度器在跑**：retention sweep 不会动 `conversation_turns`（一档永久保留），无冲突；indexer 会消费 outbox，正常
2. **手机时钟错误**：`createdAt` 严重错误（如 1970 或未来 100 年）会让 retrieval 时序混乱。建议 server 端做 sanity check：若 `createdAt < 2020-01-01` 或 `> now + 1day`，重写为 `now`，并在 details 里 `reason: "clock_corrected"`
3. **同 turn id 但 content 不同**（理论不会发生，UUID v7 碰撞概率极低）：当前 INSERT OR IGNORE 会保留先到的，后到的丢弃。可接受
4. **大批量阻塞**：单事务 200 条 + 200 次 ingestInteraction（含 outbox + facts 抽取）应该 < 2s，不算瓶颈。如果以后升到上千条要改异步分片
5. **server 误删 phone 已 push 的 turn**：`conversation_turns` 在 retention 策略中是一档永久，不会发生
6. **多设备 user 同时 push 同一 session**：session_id 命名规范防撞；即便撞了，turn id 还是唯一，只是消息混在一个 session 里——记忆抽取仍然能跑

## 不在本方案范围

- **完整的双向同步**（server 主动 push 状态变更到 phone）：不做。phone 拉 `/api/pull-messages` 已够用
- **端到端加密**：本地 LAN，依赖 WiFi 密码 + API key 已足够
- **冲突解决 UI**：用 UUID + INSERT OR IGNORE 后无冲突
- **历史数据 backfill**（首次同步十年的存量）：phone 端短时间不会有这么多历史，不规划

## Subagent 执行入口

阶段 1 brief 自包含，参考本文件「Phase 1」节即可让 general-purpose subagent 执行。
