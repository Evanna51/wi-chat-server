# character-push-server

Backend service for proactive character messages + persistent memory retrieval (SQLite-first).

## Architecture Overview

- All chat turns are persisted in SQLite (`interaction_log`, `conversation_turns`).
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
npm run db:query -- --table interaction_log --assistant d244644b-e851-416a-ad98-b557fb991b99 --limit 10

# latest 10 chat turns by character name (fuzzy)
npm run db:query -- --table interaction_log --name 金琉 --limit 10

# memory items in a time window (ISO or unix ms)
npm run db:query -- --table memory_items --assistant d244644b-e851-416a-ad98-b557fb991b99 --from "2026-03-13T00:00:00+08:00" --to "2026-03-14T00:00:00+08:00"

# JSON output for scripts
npm run db:query -- --table outbox_events --assistant d244644b-e851-416a-ad98-b557fb991b99 --json
```

### Query examples: autonomous life/push + role

Use these commands when you want to quickly inspect recent autonomous runs and role-level data (all via Quick DB query tool).

```bash
# 1) recent autonomous life runs (latest 20)
npm run db:query -- --table autonomous_run_log --assistant d244644b-e851-416a-ad98-b557fb991b99 --run-type life_tick --limit 20

# 2) recent autonomous proactive message runs (latest 20)
npm run db:query -- --table autonomous_run_log --assistant d244644b-e851-416a-ad98-b557fb991b99 --run-type proactive_message_tick --limit 20

# 3) recent local pull outbox records by user
npm run db:query -- --table local_outbox_messages --user default-user --limit 20

# 4) query one role profile by assistant_id
npm run db:query -- --table assistant_profile --assistant d244644b-e851-416a-ad98-b557fb991b99 --limit 1

# 5) recent life/work memories for one role
npm run db:query -- --life --assistant d244644b-e851-416a-ad98-b557fb991b99 --limit 20
```

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

### 9) Admin: Metrics

- `GET /admin/memory-metrics`
- Purpose: outbox/retrieval counters

### 10) Admin: Run Indexer Once

- `POST /admin/run-indexer-once`
- Purpose: manual outbox consume/index trigger

### 11) Admin: Replay Dead Letter

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
