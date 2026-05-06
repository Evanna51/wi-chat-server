-- Migration 015: 移除 local_subscribers 表
--
-- 该表只服务于已删除的 HTTP 轮询通道（/api/register-local-inbox / /api/pull-messages
-- 启动时 fallback 取 userId 用），实时推送已统一走 WebSocket，无需订阅者注册表。
--
-- local_outbox_messages（WS 离线队列）保留不动，由 ws/server.js 与 scheduler.js 继续使用。

DROP TABLE IF EXISTS local_subscribers;
