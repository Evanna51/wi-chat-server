# Character Push Server Target

## Goal
Build a standalone service for `character` assistants:
- Treat all sessions created by the same assistant as the same character identity.
- Track relationship progress (`familiarity`, total turns, recent interactions).
- Trigger proactive messages by time bucket (morning/noon/afternoon/evening/late-night/dawn).
- Push proactive messages to Android via FCM HTTP v1.

## Stack
- Node.js
- SQLite (better-sqlite3)
- Scheduler (node-cron)
- FCM HTTP v1 (google-auth-library)

## Current MVP Scope
1. API endpoints:
   - `POST /api/register-push-token`
   - `POST /api/report-interaction`
   - `GET /api/health`
2. Persistent stores:
   - `character_state`
   - `push_token`
   - `interaction_log`
   - `proactive_message_log`
3. Scheduler:
   - periodic proactive tick (`PROACTIVE_CRON`)
   - simple trigger/cooldown rules
4. Push:
   - send FCM notification + data payload (`assistantId`, `sessionId`, `message`)

## Next Iterations
1. Replace template proactive text with real LLM generation.
2. Introduce richer life logic:
   - weekday/weekend routines
   - work/sleep windows
   - familiarity-based message style
3. Add delivery reliability:
   - retry queue
   - invalid token cleanup
4. Add admin endpoints for debugging:
   - list character states
   - force proactive tick
   - view recent proactive logs

## Android Integration Contract (initial)
- When user sends/receives chat:
  - call `POST /api/report-interaction`
  - fields: assistantId, sessionId, role, content
- On FCM token refresh:
  - call `POST /api/register-push-token`
- On receiving proactive push:
  - route to session and optionally append message to local DB

