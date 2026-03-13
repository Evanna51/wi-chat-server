# character-push-server

Backend service for proactive character messages.

## Quick Start

1. Copy env:
   - `cp .env.example .env`
2. Fill FCM config:
   - `FCM_PROJECT_ID`
   - `FCM_SERVICE_ACCOUNT_PATH`
3. Install deps:
   - `npm install`
4. Run:
   - Optional (recommended for ANN search): `npm run sidecar:hnsw`
   - `npm run dev`

## Endpoints

- `GET /api/health`
- `POST /api/register-push-token`
- `POST /api/report-interaction`
- `POST /api/chat-with-memory`
- `GET /admin/memory-metrics`
- `POST /admin/run-indexer-once`
- `POST /admin/replay-dead-letter`

All POST endpoints require header: `x-api-key: <APP_API_KEY>`.

## Memory pipeline (SQLite-first)

1. `/api/report-interaction` writes turn + memory item + outbox event in one SQLite transaction.
2. Indexer worker consumes outbox and writes vectors to the configured vector provider (`hnswlib` sidecar or sqlite fallback).
3. Retrieval service merges vector score + recency + salience + graph boost.
4. LangChain + local Qwen generates memory-aware responses and proactive messages.
