# character-push-server

Backend service for proactive character messages + persistent memory retrieval (SQLite-first).

## Architecture Overview

- All chat turns are persisted in SQLite (`conversation_turns`).
- Memory units are extracted into `memory_items` and indexed asynchronously via outbox worker.
- Vector retrieval uses pluggable provider:
  - default: `sqlite` fallback
  - optional: `hnswlib` sidecar (`npm run sidecar:hnsw`)
- Retrieval decision is AI-driven (`localhost:1234` OpenAI-compatible endpoint).

## Quick Start (cross-platform)

Requires **Node.js 22 LTS** or newer.

1. Install dependencies:
   - `npm install`
2. Initialize `.env` and `data/`:
   - `npm run setup`
3. Set required values in `.env`:
   - `APP_API_KEY`
   - `QWEN_BASE_URL` (default `http://127.0.0.1:1234/v1`)
   - `QWEN_MODEL`
4. Start API service:
   - `npm run dev`

Service default address: `http://127.0.0.1:8787`

### Windows Notes

- **Recommended branch**: use `main-win` for Windows-tuned config; `main` is developed on macOS/Linux.
- **Vector backend**: stick with `VECTOR_PROVIDER=sqlite` (default in this branch). The optional `hnswlib` sidecar requires native compilation and is skipped automatically (`hnswlib-node` is in `optionalDependencies`).
- **If you actually want the HNSW sidecar on Windows**: install Visual Studio Build Tools + Python 3, then `npm install hnswlib-node`.
- **Path examples** in `.env`: forward slashes work in Node on Windows too. `FCM_SERVICE_ACCOUNT_PATH=C:/keys/firebase.json` is valid.
- **Run as a service**: use [NSSM](https://nssm.cc/) to wrap `npm start` into a Windows Service for auto-start.
- **Firewall**: first inbound request from another device on port 8787 will trigger a Windows Defender prompt — allow private networks.

### Expose WSL2 service to LAN (phone access)

If the service runs inside **WSL2**, devices on the same WiFi can't reach it directly — WSL2 runs in a VM with its own (changing) IP. Two options:

**Option A — Windows portproxy + firewall (works on all Win10/11)**

1. In WSL `.env`, set `HOST=0.0.0.0` (otherwise the server binds to loopback only).
2. From a Windows PowerShell (the script self-elevates to admin):
   ```powershell
   .\scripts\windows\expose-wsl-port.ps1
   # custom port:
   .\scripts\windows\expose-wsl-port.ps1 -Port 9000
   ```
   It detects the current WSL IP, adds a `netsh interface portproxy` rule, opens the firewall on the Private profile, and prints the LAN URLs you can hit from your phone.
3. **Re-run after every WSL restart** — the WSL IP can change.
4. To remove: `.\scripts\windows\teardown-wsl-port.ps1 -Port 8787`

**Option B — WSL2 mirrored networking (Win11 22H2+)**

Add to `%UserProfile%\.wslconfig`:
```ini
[wsl2]
networkingMode=mirrored
```
Then `wsl --shutdown` and restart WSL. WSL2 will share the host's NIC, no portproxy needed. Just open the firewall once (the script above also does this; or run only the `New-NetFirewallRule` part).

### Linux/macOS Notes

If you want the HNSW sidecar:
1. `npm install hnswlib-node` (will compile from source)
2. `npm run sidecar:hnsw`
3. Set `VECTOR_PROVIDER=hnswlib` in `.env`

## 运行方式

### 直接运行（开发调试）

```bash
npm run dev
```

进程前台运行，Ctrl-C 退出，日志直接打到终端。

### PM2 托管（生产 / 长期运行）

> 前置：`npm install -g pm2`

```bash
npm start          # 启动（后台，fork 模式）
npm run status     # 查看进程状态
npm run logs       # 实时日志（Ctrl-C 退出查看，进程继续运行）
npm restart        # 热重启（重载代码但 PM2 进程不退出）
npm stop           # 停止
```

日志文件落在 `./logs/`（已加入 `.gitignore`）。进程名：`wi-chat-server`。

**SQLite 单写限制**：`ecosystem.config.js` 固定 `exec_mode: "fork"` + `instances: 1`，禁止改为 cluster，否则多进程并发写会损坏 WAL 文件。

`kill_timeout` 设为 10 s，给在途 LLM 调用留足排空时间。

## Scripts

- `npm run setup` - create `.env` from `.env.example` and ensure `data/` exists (cross-platform)
- `npm run dev` - start API + scheduler + memory indexer
- `npm run start` - start production mode entry
- `npm run sidecar:hnsw` - start local HNSW vector sidecar (optional, requires `hnswlib-node`)
- `npm run indexer:once` - run one indexer batch manually
- `npm run eval:memory` - run retrieval eval seed dataset
- `npm run db:query -- ...` - query SQLite quickly with filters
- `npm run autonomous:run -- ...` - run autonomous cron tasks on demand

### Run autonomous task quickly (without manual DB insert)

Use this util to execute scheduler tasks directly (life/message/all), instead of manually inserting mock outbox rows.

```bash
# run both life + message tasks
npm run autonomous:run -- --job all

# run only proactive message for one role
npm run autonomous:run -- --job message --assistant d244644b-e851-416a-ad98-b557fb991b99

# run only life for multiple roles
npm run autonomous:run -- --job life --assistants d244...,869e...
```

### Quick DB query tool

Use this to inspect server-side data quickly by `assistant_id`, `session_id`, and time range.

Examples:

```bash
# latest 10 chat turns by assistant
npm run db:query -- --table conversation_turns --assistant d244644b-e851-416a-ad98-b557fb991b99 --limit 10

# latest 10 chat turns by character name (fuzzy)
npm run db:query -- --table conversation_turns --name 金琉 --limit 10

# memory items in a time window (ISO or unix ms)
npm run db:query -- --table memory_items --assistant d244644b-e851-416a-ad98-b557fb991b99 --from "2026-03-13T00:00:00+08:00" --to "2026-03-14T00:00:00+08:00"

# JSON output for scripts
npm run db:query -- --table outbox_events --assistant d244644b-e851-416a-ad98-b557fb991b99 --json
```

### Query examples: autonomous life/push + role

Use these commands when you want to quickly inspect recent autonomous runs and role-level data (all via Quick DB query tool).

```bash
# 1) recent autonomous life runs (latest 20)
npm run db:query -- --table character_behavior_journal --assistant d244644b-e851-416a-ad98-b557fb991b99 --run-type life_tick --limit 20

# 2) recent autonomous proactive message runs (latest 20)
npm run db:query -- --table character_behavior_journal --assistant d244644b-e851-416a-ad98-b557fb991b99 --run-type proactive_message_tick --limit 20

# 3) recent local pull outbox records by user
npm run db:query -- --table local_outbox_messages --user default-user --limit 20

# 4) query one role profile by assistant_id
npm run db:query -- --table assistant_profile --assistant d244644b-e851-416a-ad98-b557fb991b99 --limit 1

# 5) recent life/work memories for one role
npm run db:query -- --life --assistant d244644b-e851-416a-ad98-b557fb991b99 --limit 20
```

## Visualizer & Management UI

服务自带一个轻量的可视化与管理面板，无需额外部署：

- 启动服务后访问 `http://<HOST>:<PORT>/`（默认 `http://127.0.0.1:8787/`），即可看到角色列表、概况指标、调度配置等。
- 单角色页支持：概览 / 对话 / 记忆 / 行为日志 / Facts / 管理 共 6 个 Tab，并提供全文搜索（FTS5）入口。
- 后端路由统一挂在 `GET|PATCH|POST /api/browse/*`，与已有 `/api` 一致受 `x-api-key` 保护。
- 浏览器侧通过 `localStorage.apiKey` 读取 API key：开发态默认值是 `dev-local-key`，要改用真实 key 时在浏览器控制台执行 `localStorage.setItem('apiKey', '<your-key>')` 后刷新。当 `REQUIRE_API_KEY=0` 时（dev 模式默认）服务端跳过校验。
- 管理页（角色 → 管理 Tab）可：
  - 切换 `allowAutoLife` / `allowProactiveMessage` 开关（PATCH `/api/browse/assistants/:id/flags`）；
  - 手动触发 life / proactive-message 任务（POST `/api/browse/assistants/:id/run`）。**dryRun 默认勾选**：勾选时不会写入 `memory_items`、不会推送 FCM、不会写 `local_outbox_messages`，只会写一条 `status=dry_run` 的 `character_behavior_journal`；取消勾选则等价于 cron 真实运行，会真实持久化记忆并按 push 配置推送。
- 对话页（角色 → 对话 Tab）可：
  - hover 任意气泡显示"× 删除"按钮，确认后**级联硬删**该 turn + 衍生 memory_item / facts / edges / vectors / outbox（DELETE `/api/browse/conversation-turns/:id`）。操作不可逆。

数据全部来自本地 SQLite，没有额外缓存层，刷新即所见。

## Auth

- All `POST` admin/api endpoints require:
  - header `x-api-key: <APP_API_KEY>`

## API Reference

### 1) Health

- `GET /api/health`
- Purpose: health check
- Response:
```json
{ "ok": true, "ts": 1773409142807 }
```

### 2) Register Push Token

- `POST /api/register-push-token`
- Body:
```json
{
  "userId": "default-user",
  "token": "fcm_token_xxx",
  "platform": "android"
}
```
- Response:
```json
{ "ok": true }
```

### 7) Tool Endpoint: Memory Context (recommended for app integration)

- `POST /api/tool/memory-context`
- Purpose: AI decides whether to retrieve memory and returns memory hints for your chat model.
- Body:
```json
{
  "assistantId": "assistant_demo",
  "sessionId": "session_1",
  "userInput": "你还记得我喜欢什么吗？",
  "topK": 3
}
```

#### Response when `shouldRetrieve=true`
```json
{
  "ok": true,
  "shouldRetrieve": true,
  "intent": "fact_query",
  "reason": "user_asks_about_preferences",
  "decisionSource": "ai",
  "retrievalQuery": "what_are_my_preferences",
  "memoryLines": [
    "User记忆: 我喜欢喝美式咖啡，最近在学羽毛球"
  ],
  "memoryGuidance": "记忆: ...\n结合建议: ...",
  "memories": [
    { "id": "xxx", "content": "我喜欢喝美式咖啡，最近在学羽毛球", "score": 0.69 }
  ],
  "relationshipState": { "...": "见 14.x 节" }
}
```

#### Response when `shouldRetrieve=false`
```json
{
  "ok": true,
  "shouldRetrieve": false,
  "intent": "small_talk",
  "reason": "user_acknowledgment_no_history_needed",
  "decisionSource": "ai",
  "memoryLines": [],
  "relationshipState": { "...": "见 14.x 节" }
}
```

Notes:
- `memoryGuidance` is returned only when `shouldRetrieve=true`.
- `intent` values include: `fact_query`, `continuation`, `care_response`, `small_talk`, `task_only`.
- `relationshipState` 字段始终存在；当角色尚未交互过、`character_state` 行不存在时为 `null`。完整 schema 见 `GET /api/relationship/state` 段。

### 7.1) Tool: Memory Recall (agentic search)

- `POST /api/tool/memory-recall`
- 给客户端 LLM 的 search_memory tool 直接调用。**不做 decision**（与 memory-context 区别）；LLM 已决定要查，server 哑执行。
- Body:
```json
{
  "assistantId": "assistant_demo",
  "query": "用户最近聊到的咖啡",
  "source": "user",
  "category": "preferences",
  "minQuality": "B",
  "topK": 5
}
```
- `source` ∈ {`user`, `character`, `all`}，默认 `user`
- `category` 可选：`chitchat / personal_experience / relationship_info / knowledge / goals_plans / preferences / decisions_reflections / wellbeing / ideas`
- `minQuality` 可选：`A`/`B`/`C`/`D`/`E`
- 响应返回每条 memory 的 `id` / `content` / `category` / `quality` / `score`，AI 可拿 id 喂给 memory-correct 做修正

### 7.2) Tool: Memory Correct (delete / update)

给客户端 AI 修正过去错误记忆的工具。

- `POST /api/tool/memory-correct`
- Body:
```json
{
  "assistantId": "assistant_demo",
  "memoryId": "019dca12-3b4c-...",
  "action": "delete",
  "reason": "用户后来澄清这是反话"
}
```
或：
```json
{
  "assistantId": "assistant_demo",
  "memoryId": "019dca12-3b4c-...",
  "action": "update",
  "newContent": "其实我喜欢的是美式不是拿铁",
  "reason": "用户后来澄清"
}
```

行为：

| action | 影响 |
|--------|------|
| `delete` | 级联删 memory_item + memory_facts/edges/vectors + outbox events + 源 conversation_turn |
| `update` | 就地改 content + `vector_status='pending'` 触发重 embed；**保留** conversation_turn 不可篡改原始对话 |

防护：
- `assistantId` 强校验，memory 必须属于该 assistant，否则 404 `assistant_mismatch`
- `memoryId` 不存在 → 404 `memory_not_found`
- `action=update` 但缺 `newContent` → 400 `update_requires_newContent`
- `action=update` 时 `newContent` 不能为空白 → 400 `empty_content`

典型流程：客户端 AI 用 memory-recall 拿到一批候选 → 判断哪条错误 → 用其 `id` 调 memory-correct。

### 8) Chat With Memory (server-side generation)

- `POST /api/chat-with-memory`
- Purpose: server performs retrieval + generates answer with local Qwen.
- Body:
```json
{
  "assistantId": "assistant_demo",
  "sessionId": "session_1",
  "userInput": "你记得我喜欢什么吗？"
}
```

### 9) Search (FTS5 over conversation + memory)

- `POST /api/search`
- Purpose: full-text search over `conversation_turns` and `memory_items` (BM25-ranked when query length >= 3; falls back to `LIKE` for shorter queries).
- Body:
```json
{
  "assistantId": "assistant_demo",
  "q": "拿铁",
  "scope": "both",
  "limit": 20
}
```
- `scope` is one of `conversation`, `memory`, `both` (default).
- Response:
```json
{
  "ok": true,
  "hits": [
    {
      "kind": "conversation",
      "id": "019dc...",
      "content": "我喜欢喝拿铁，最近在学羽毛球",
      "score": -6.51,
      "role": "user",
      "sessionId": "s1",
      "createdAt": 1777204051655
    }
  ]
}
```

### 10) Sync API (offline batch drain)

**唯一的对话写入路径**：所有 user / assistant / tool_call / tool_result / system turn 都通过 sync 接口入库，client-generated UUID v7 作为 turn id，**完美幂等**（同一条 turn 不论 push 多少次只落库一次）。完整设计见 `docs/offline-sync-plan.md`，Android 落地清单见 `docs/android-sync-integration.md`。

- `POST /api/sync/push`        — 实时单条 / 小批量推送（在线时低延迟体验）
- `POST /api/sync/snapshot`    — 一次性同步 assistants + turns（daily sync / 角色信息变更时用）
- `GET  /api/sync/state`       — phone 自检本地缓存与 server 状态是否一致

#### 10.1 POST /api/sync/push

Body（基础 user / assistant 行）：
```json
{
  "deviceId": "android-001",
  "turns": [
    {
      "id": "019dca12-3b4c-7890-abcd-1234567890ab",
      "assistantId": "assistant_demo",
      "sessionId": "android-001-s1",
      "role": "user",
      "content": "在路上想到一个事...",
      "createdAt": 1777200000000
    }
  ]
}
```

支持的 5 种 `role`：

| role | content | 额外字段 | server 行为 |
|------|---------|---------|------------|
| `user` | 必填非空 | — | 进 memory_items + 分类 + 向量 + outbox |
| `assistant` | 必填非空 | — | 同上 |
| `tool_call` | 允许空字符串 | `toolCallsJson` 必填（OpenAI 风格 tool_calls 数组） | 仅写 `conversation_turns`，不进 memory pipeline |
| `tool_result` | 必填（结果 JSON） | `toolCallId` + `toolName` 必填 | 仅写 `conversation_turns`，不进 memory pipeline |
| `system` | 必填 | — | 仅写 `conversation_turns`，不进 memory pipeline |

`tool_call` / `tool_result` / `system` 这三种"日志型" role 不进 memory_items、不分类、不生成向量、不出 outbox，但 FTS5 trigger 自动索引，`/api/search?scope=conversation` 仍可命中。

带 tool_call 的 payload 示例：
```json
{
  "deviceId": "android-001",
  "turns": [
    {
      "id": "019dca12-3b4c-7890-abcd-...01",
      "assistantId": "assistant_demo",
      "sessionId": "s1",
      "role": "tool_call",
      "content": "",
      "createdAt": 1777200000000,
      "toolCallsJson": "[{\"id\":\"call_xxx\",\"type\":\"function\",\"function\":{\"name\":\"search_memory\",\"arguments\":\"{...}\"}}]"
    },
    {
      "id": "019dca12-3b4c-7890-abcd-...02",
      "assistantId": "assistant_demo",
      "sessionId": "s1",
      "role": "tool_result",
      "content": "{\"ok\":true,\"hits\":[...]}",
      "createdAt": 1777200001000,
      "toolCallId": "call_xxx",
      "toolName": "search_memory"
    }
  ]
}
```

约束：
- `turns.length` 区间 `[1, 200]`，超过 200 返回 400（强制 phone 拆批）。
- `id` 必须是 client-generated UUID v7（前缀含时间戳，天然有序）。
- `createdAt` 是 phone 本地毫秒时间戳；server 端做 sanity check：若 `< 2020-01-01` 或 `> now + 1d`，会矫正为 `Date.now()`，details 里附 `reason: "clock_corrected"`，**仍然算 accepted**。
- `tool_call` 行 `toolCallsJson` 缺失会被 reject（`reason: "tool_call_missing_payload"`）。
- `tool_result` 行 `toolCallId` 或 `toolName` 缺失会被 reject（`reason: "tool_result_missing_metadata"`）。

Response：
```json
{
  "ok": true,
  "deviceId": "android-001",
  "accepted": 47,
  "skipped": 3,
  "rejected": 0,
  "details": [
    { "id": "...", "status": "accepted" },
    { "id": "...", "status": "skipped", "reason": "already_exists" }
  ]
}
```

幂等语义：
- 同 `id` 第二次起 → `skipped: already_exists`，不会重复写 `memory_items` / `memory_facts` / `outbox_events`。
- 单事务整批，单条 `rejected` 不会 roll back 其它 accepted 行。
- `assistantId` **不强约束** `assistant_profile` 必须存在（角色由 phone 创建）。

`character_state` 联动（仅对 `assistant_profile` 已存在的 assistant 生效）：
- `total_turns` 累加本批次中 accepted 的 user-role turn 数；`familiarity = floor(total_turns / 3)`，封顶 100。
- `last_user_message_at` 推进到本批次最大 user createdAt。
- 用本批次最后一条 user content 调 `onUserMessage`（mood / intimacy / energy 启发式更新），单次调用避免历史消息间 silenceEffect 错乱触发。
- 没有 profile 的 assistant 仅入 `conversation_turns` / `memory_items`，**不污染** state 表。

cURL 示例（push 一条 + 重推演示 skipped）：
```bash
TURN_ID=$(node -e "console.log(require('uuid').v7())")
PAYLOAD=$(printf '{"deviceId":"demo","turns":[{"id":"%s","assistantId":"assistant_demo","sessionId":"demo-s1","role":"user","content":"户外离线消息","createdAt":%s}]}' "$TURN_ID" "$(date +%s000)")

# 第一次 → accepted=1
curl -sS -X POST "http://127.0.0.1:8787/api/sync/push" \
  -H "x-api-key: dev-local-key" \
  -H "content-type: application/json" \
  --data "$PAYLOAD"

# 第二次 → skipped=1
curl -sS -X POST "http://127.0.0.1:8787/api/sync/push" \
  -H "x-api-key: dev-local-key" \
  -H "content-type: application/json" \
  --data "$PAYLOAD"
```

#### 10.1.1 POST /api/sync/snapshot — 一次性同步 assistants + turns

为了避免 phone 端逐个调 `assistant-profile/upsert` 再 push turns，新增 snapshot 端点一次性推。语义：

- `assistants[]` 走 **phone-wins INSERT-OR-REPLACE**：`characterName` / `characterBackground` / `allowAutoLife` / `allowProactiveMessage` 一律以 phone 端值为准，已有行直接覆盖。
- `turns[]` 复用 `/api/sync/push` 全套校验和入库逻辑（5 种 role / tool 字段 / 幂等 / clock_corrected）。
- `assistants` 和 `turns` 都可选；至少有一个。两个都为空返回 400 `empty_snapshot`。
- assistants 先 upsert，再走 turns，再触发 character_state（仅对已 upsert / 已存在 profile 的 assistant）。

Body：
```json
{
  "deviceId": "android-001",
  "assistants": [
    {
      "assistantId": "869e5840-...",
      "characterName": "锡金",
      "characterBackground": "一个内敛安静的角色",
      "allowAutoLife": false,
      "allowProactiveMessage": false
    }
  ],
  "turns": [
    {
      "id": "019dca12-3b4c-...",
      "assistantId": "869e5840-...",
      "sessionId": "android-001-s1",
      "role": "user",
      "content": "...",
      "createdAt": 1777200000000
    }
  ]
}
```

Response：
```json
{
  "ok": true,
  "deviceId": "android-001",
  "assistants": {
    "received": 1,
    "upserted": 1,
    "failed": 0,
    "details": [{ "assistantId": "...", "status": "upserted", "characterName": "锡金" }]
  },
  "turns": {
    "received": 3,
    "accepted": 3,
    "skipped": 0,
    "rejected": 0,
    "details": [...]
  },
  "cancelledPlans": 0,
  "stateUpdated": 1
}
```

`assistants.length` 上限 500，`turns.length` 上限 200（与 sync-push 一致）。

#### 10.2 GET /api/sync/state

```
GET /api/sync/state?assistantId=<id>&deviceId=<id>
```

Response：
```json
{
  "ok": true,
  "now": 1777200000000,
  "assistantId": "assistant_demo",
  "deviceId": "android-001",
  "assistantTurnCount": 1234,
  "totalTurnCount": 5678,
  "lastTurnAt": 1777199000000
}
```

`assistantId` 不传时 `assistantTurnCount = null`，`lastTurnAt` 退化为全表 MAX。`deviceId` 当前不影响结果，仅作 phone 端契约预留。

#### 10.3 sync-replay 脚本

```bash
# 1) 生成 50 条本地缓存
npm run sync:replay -- --mode generate --assistant smoke-sync --count 50 --out /tmp/buf.json

# 2) push 上去
npm run sync:replay -- --mode push --in /tmp/buf.json

# 3) 一键端到端（generate + push 两次验证幂等）
npm run sync:replay -- --mode test --assistant smoke-sync --count 20

# 4) Phase 4 e2e（push + state + memory_items 校验）
npm run sync:replay -- --mode e2e --assistant smoke-sync --count 30

# 5) tool-roles 验证（5 行 user/assistant/tool_call/tool_result/system 序列）
npm run sync:replay -- --mode tool-roles --assistant smoke-toolroles
```

通用参数：`--api http://...` `--api-key dev-local-key` `--batch-size 100` `--device-id ...`。

### 11) Admin: Metrics

- `GET /admin/memory-metrics`
- Purpose: outbox/retrieval counters

### 12) Admin: Run Indexer Once

- `POST /admin/run-indexer-once`
- Purpose: manual outbox consume/index trigger

### 13) Admin: Replay Dead Letter

- `POST /admin/replay-dead-letter`
- Body:
```json
{ "limit": 20 }
```

### 14) WebSocket Push Channel

实时推送通道，替代 `GET /api/pull-messages` 轮询。在线时 server → phone 直推，断线时落 `local_outbox_messages` 兜底，重连后 server 一次性 flush 积压。

#### 14.1 握手

```
ws://<host>:<port>/api/ws?apiKey=<APP_API_KEY>&userId=<userId>
```

也支持 header：`x-api-key` + `x-user-id`。`REQUIRE_API_KEY=0` 时跳过 apiKey 校验。

握手成功 server 立即发：
- 一帧 `{ "op":"hello", "userId":"...", "ts":<ms> }`
- 如果该 user 有积压消息，再发一帧 `queued_batch`（见下）

#### 14.2 帧格式

**Server → Client**

`hello`（连接确认）：
```json
{ "op": "hello", "userId": "default-user", "ts": 1777200000000 }
```

`proactive`（主动消息推送）：
```json
{
  "op": "proactive",
  "id": "<plan-id>",
  "assistantId": "...",
  "sessionId": "...",
  "title": "...",
  "body": "...",
  "messageType": "character_proactive",
  "payload": { "planId": "...", "intent": "...", "anchorTopic": "...", "triggerReason": "..." },
  "createdAt": 1777200000000
}
```

`queued_batch`（重连时的积压消息）：
```json
{
  "op": "queued_batch",
  "messages": [
    { "id": "...", "assistantId": "...", "sessionId": "...", "messageType": "character_proactive",
      "title": "...", "body": "...", "payload": {...}, "createdAt": ..., "availableAt": ..., "expiresAt": ..., "pullCount": 1 }
  ]
}
```

`pong`（心跳响应）：
```json
{ "op": "pong", "ts": 1777200000000 }
```

`server_shutdown`（进程退出广播）：
```json
{ "op": "server_shutdown", "ts": 1777200000000 }
```

**Client → Server**

`ping`（每 25s 一次）：
```json
{ "op": "ping", "ts": 1777200000000 }
```

`ack`（收到消息后）：
```json
{ "op": "ack", "id": "<message-id>", "status": "received" }
```

server 收到 ack 后将对应 `local_outbox_messages.status` 更新为 `acked`。

`presence`（可选，告知客户端当前是否在 chat 界面）：
```json
{ "op": "presence", "state": "active|background", "assistantId": "..." }
```

`subscribe`（重发触发，可选）：
```json
{ "op": "subscribe", "userId": "..." }
```

#### 14.3 心跳

- Client 每 25s 发一次 `ping`，server 回 `pong`
- Server 还会通过 RFC 6455 ping 帧 (TCP-level) 每 25s 探活，超过一个周期未收到 pong 则 `terminate()`

#### 14.4 测试客户端

```
npm run ws:test -- --user default-user --api-key dev-local-key
```

可选参数 `--host <host>` `--port <port>`。

### 15) Character Catchup (lazy life memory)

- `POST /api/character/catchup`
- Body:
```json
{
  "assistantId": "...",
  "lastInteractionAt": 1777190000000,
  "now": 1777200000000,
  "maxEvents": 5
}
```
- Response:
```json
{ "ok": true, "windowMs": 10000000, "generated": 3, "memories": [...] }
```

仅当 `now - lastInteractionAt >= 60min` 时才生成；否则返回 `generated: 0`。

### 16) Proactive Plans

#### 16.1 立即生成 plan

```
POST /api/proactive/regenerate-plans
body: { "assistantId": "..." }   // 不传则跑全部 allow_proactive_message=1 的角色
```

#### 16.2 列出 plan

```
GET /api/proactive/plans?status=<pending|sent|cancelled|failed|all>&assistantId=<id>&limit=<n>
```

`status` 默认 `pending`；`assistantId` 可选；`limit` 可选。

#### 16.3 取消 pending plan

```
DELETE /api/proactive/plans/:id
body: { "reason": "..." }       // 可选
```

只对 `status=pending` 的 plan 生效。

### 17) Relationship State (角色情绪 / 关系 / 精力快照)

- `GET /api/relationship/state?assistantId=<id>`
- 给客户端 `RelationshipStateStore.upsertFromServerJson` 用，每次连接 / 进入 chat 时拉一次刷新本地状态。
- `character_state` 行不存在时自动以默认值（`mood=calm` / `relationship=陌生人` / `energy=0.7`）初始化，**永远不会返回 404**。
- 同样的 payload 也作为 `relationshipState` 字段夹带在 `POST /api/tool/memory-context` 的所有 response 路径中（`shouldRetrieve` 为 true / false / 系统关闭），客户端可二选一消费。

Response：

```json
{
  "ok": true,
  "assistantId": "assistant_demo",
  "relationshipState": {
    "assistantId": "assistant_demo",
    "mood": {
      "emotion": "calm",
      "emotionZh": "平静",
      "emotionEn": "calm",
      "intensity": 0.3,
      "valence": 0.1,
      "arousal": 0.2,
      "updatedAt": null
    },
    "relationship": {
      "level": 0,
      "levelName": "陌生人",
      "intimacyScore": 0,
      "familiarity": 0,
      "totalTurns": 0
    },
    "energy": { "value": 0.7, "updatedAt": null },
    "focus": null,
    "lastUserMessageAt": null,
    "lastProactiveAt": null,
    "updatedAt": 1778100000000
  },
  "ts": 1778100000000
}
```

字段语义：

| 路径 | 含义 |
|------|------|
| `mood.emotion` | 27+95 GoEmotions 词库的 id（base 27 个 / secondary 95 个） |
| `mood.intensity` | 0.1–1.0，情绪强度 |
| `mood.valence` | -1.0–1.0，效价（负面 → 正面） |
| `mood.arousal` | 0–1.0，激活度（平静 → 兴奋） |
| `relationship.level` | -2(冷战) / -1(疏远) / 0(陌生人) ... / 9(灵魂伴侣)，共 12 档 |
| `relationship.intimacyScore` | 累积亲密分，driver of level 升降 |
| `relationship.familiarity` | 旧字段，由 `total_turns` 计算（`floor(total_turns/3)`，封顶 100） |
| `energy.value` | 0.1–1.0，精力值，沉默期会衰减 |
| `focus.topic` / `focus.depth` | 当前话题焦点 + 已深入轮次 |

衰减语义：每次 `getEffectiveState` 都会按时间应用 mood / energy 衰减，所以你拿到的 valence/arousal/intensity/energy 是**当前时刻**的值，不是上次写入的存档值。

## Recommended Calling Flow (chatbox-Android)

For each turn:

1. Stamp a UUID v7 turn id (`SyncQueueDrainer.stampForSync`) and persist locally.
2. Get memory tool context for the user input:
   - call `POST /api/tool/memory-context`
3. Build your chat model prompt:
   - if `shouldRetrieve=true`, append `memoryLines` + `memoryGuidance`
   - 不论 `shouldRetrieve`，response 里的 `relationshipState` 都是当前角色快照，喂回 prompt
4. Generate final answer in your chat AI; persist locally with same flow.
5. Push to server:
   - 在线 / 小批量：`POST /api/sync/push`（含 user / assistant / tool_call / tool_result / system 任意混合）
   - 离线积压 + 角色信息变更：`POST /api/sync/snapshot`（一次推 assistants + turns）

幂等保证：phone 端 turn id 不变、无限重推，server 永远只落一次库。

## cURL Examples

### A) sync-push（实时单条 / 小批量）

```bash
TURN_ID=$(node -e "console.log(require('uuid').v7())")
curl -sS -X POST "http://127.0.0.1:8787/api/sync/push" \
  -H "x-api-key: dev-local-key" \
  -H "content-type: application/json" \
  --data "{\"deviceId\":\"demo\",\"turns\":[{\"id\":\"$TURN_ID\",\"assistantId\":\"assistant_demo\",\"sessionId\":\"s1\",\"role\":\"user\",\"content\":\"我喜欢喝美式咖啡\",\"createdAt\":$(date +%s000)}]}"
```

### B) memory-context

```bash
curl -X POST "http://127.0.0.1:8787/api/tool/memory-context" \
  -H "x-api-key: dev-local-key" \
  -H "content-type: application/json" \
  --data '{"assistantId":"assistant_demo","sessionId":"session_1","userInput":"你还记得我喜欢什么吗？","topK":3}'
```

## 备份与恢复

### 自动调度

备份由 `src/scheduler.js` 自动运行，无需手动干预：

| 任务 | Cron（Asia/Shanghai） | 产出 |
|------|-----------------------|------|
| 增量备份 | 每天 03:00 (`BACKUP_DAILY_CRON`) | `data/backups/incr-YYYY-MM-DD.jsonl.gz` |
| 全量备份 | 每周日 02:30 (`BACKUP_WEEKLY_CRON`) | `data/backups/full-YYYY-Www.sqlite` |

保留策略：增量保留 8 天，全量保留 4 周，写入新文件后自动清理过期文件。

### 手动运行

```bash
# 立即生成今日增量备份
node scripts/backup.js daily

# 立即生成本周全量快照（已存在则跳过）
node scripts/full-backup.js

# 验证增量文件完整性
node scripts/backup.js verify data/backups/incr-2026-04-28.jsonl.gz

# 列出所有增量文件
node scripts/restore.js --list-incr
```

### 恢复流程

```bash
# 1. 停服
pm2 stop wi-chat-server

# 2. 恢复（全量 + 增量）
node scripts/restore.js \
  --from data/backups/full-2026-W17.sqlite \
  --db data/character-behavior.db \
  --apply data/backups/incr-2026-04-26.jsonl.gz \
           data/backups/incr-2026-04-27.jsonl.gz \
           data/backups/incr-2026-04-28.jsonl.gz

# 3. 验证行数
node scripts/backup.js daily   # 跑一次增量，看表行数输出

# 4. 重启
pm2 start wi-chat-server
```

> `restore.js` 会在覆盖目标 DB 前自动备份一份 `.restore-bak.<timestamp>` 防止操作失误。
