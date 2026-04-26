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

### 3) Report Interaction (full chat log persistence)

- `POST /api/report-interaction`
- Use this for **every user/assistant turn**, including small talk.
- Body:
```json
{
  "assistantId": "assistant_demo",
  "sessionId": "session_1",
  "role": "user",
  "content": "我喜欢喝美式咖啡，最近在学羽毛球"
}
```
- Response:
```json
{
  "ok": true,
  "familiarity": 0,
  "totalTurns": 1
}
```

### 4) Register Local Inbox Subscriber (for pull mode)

- `POST /api/register-local-inbox`
- Body:
```json
{
  "userId": "default-user",
  "deviceId": "android-001"
}
```

### 5) Pull Pending Local Messages

- `GET /api/pull-messages?limit=20&since=0&userId=default-user`
- `userId` supports 3 ways:
  - query `userId`
  - header `x-user-id`
  - omit both only when exactly one local subscriber exists (auto fallback)
- Response:
```json
{
  "ok": true,
  "userId": "default-user",
  "since": 0,
  "count": 1,
  "messages": [
    {
      "id": "019595f0-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "assistantId": "assistant_demo",
      "sessionId": "session_1",
      "messageType": "character_proactive",
      "title": "assistant_demo 发来新消息",
      "body": "你好，想和你聊聊。",
      "payload": { "type": "character_proactive" },
      "createdAt": 1773409142807,
      "availableAt": 1773409142807,
      "expiresAt": 1774013942807,
      "pullCount": 1
    }
  ],
  "now": 1773409142900
}
```

### 6) Ack Pulled Message

- `POST /api/ack-message`
- Body:
```json
{
  "userId": "default-user",
  "messageId": "019595f0-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "ackStatus": "received"
}
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
  ]
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
  "memoryLines": []
}
```

Notes:
- `memoryGuidance` is returned only when `shouldRetrieve=true`.
- `intent` values include: `fact_query`, `continuation`, `care_response`, `small_talk`, `task_only`.

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

离线对话同步入口，用于 chatbox-Android 在户外断网时缓存对话，回家进入家庭 WiFi 后批量推送补齐 server 状态。完整设计见 `docs/offline-sync-plan.md`，Android 落地清单见 `docs/android-sync-integration.md`。

- 现有 `POST /api/report-interaction` 仍然是**单条实时上报**路径（在线时使用，低延迟体验）。
- 新增 `POST /api/sync/push` 用于**离线 batch drain**，client-generated UUID v7 作为 turn id，**完美幂等**（同一条 turn 不论 push 多少次只落库一次）。
- 新增 `GET /api/sync/state` 用于 phone 自检本地缓存与 server 状态是否一致。

#### 10.1 POST /api/sync/push

Body：
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

约束：
- `turns.length` 区间 `[1, 200]`，超过 200 返回 400（强制 phone 拆批）。
- `id` 必须是 client-generated UUID v7（前缀含时间戳，天然有序）。
- `createdAt` 是 phone 本地毫秒时间戳；server 端做 sanity check：若 `< 2020-01-01` 或 `> now + 1d`，会矫正为 `Date.now()`，details 里附 `reason: "clock_corrected"`，**仍然算 accepted**。

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

## Recommended Calling Flow (chatbox-Android)

For each turn:

1. Persist user turn:
   - call `POST /api/report-interaction` with `role=user`
2. Get memory tool context:
   - call `POST /api/tool/memory-context`
3. Build your chat model prompt:
   - if `shouldRetrieve=true`, append `memoryLines` + `memoryGuidance`
   - if `shouldRetrieve=false`, use normal prompt
4. Generate final answer in your chat AI
5. Persist assistant turn:
   - call `POST /api/report-interaction` with `role=assistant`

This keeps all chat logs persisted while memory retrieval stays selective.

## cURL Examples

### A) report-interaction

```bash
curl -X POST "http://127.0.0.1:8787/api/report-interaction" \
  -H "x-api-key: dev-local-key" \
  -H "content-type: application/json" \
  --data '{"assistantId":"assistant_demo","sessionId":"session_1","role":"user","content":"我喜欢喝美式咖啡"}'
```

### B) memory-context

```bash
curl -X POST "http://127.0.0.1:8787/api/tool/memory-context" \
  -H "x-api-key: dev-local-key" \
  -H "content-type: application/json" \
  --data '{"assistantId":"assistant_demo","sessionId":"session_1","userInput":"你还记得我喜欢什么吗？","topK":3}'
```
