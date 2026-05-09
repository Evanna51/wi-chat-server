const { WebSocketServer } = require("ws");
const config = require("../config");
const {
  register,
  unregister,
  startHeartbeatLoop,
  broadcastToUser,
} = require("./connections");
const {
  pullPendingMessagesForUser,
  ackPulledMessage,
  updateConversationTurnContent,
} = require("../db");
const { ingestTurnsBatch } = require("../services/syncIngestService");
const { deleteConversationTurnCascade } = require("../services/memoryEditService");
const { turnEvents } = require("../events/turnEvents");

function safeParse(data) {
  try {
    const text = typeof data === "string" ? data : data.toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function flushPendingForUser(userId, ws) {
  let rows = [];
  try {
    rows = pullPendingMessagesForUser({
      userId,
      since: 0,
      limit: 50,
      now: Date.now(),
      repullGapMs: config.localPullRepullGapMs,
    });
  } catch (error) {
    console.error("[ws] flush pending failed:", error.message);
    return;
  }
  if (!rows.length) return;
  const messages = rows.map((item) => ({
    id: item.id,
    assistantId: item.assistant_id,
    sessionId: item.session_id,
    messageType: item.message_type,
    title: item.title,
    body: item.body,
    payload: JSON.parse(item.payload_json || "{}"),
    createdAt: item.created_at,
    availableAt: item.available_at,
    expiresAt: item.expires_at,
    pullCount: item.pull_count + 1,
  }));
  try {
    ws.send(JSON.stringify({ op: "queued_batch", messages }));
  } catch (error) {
    console.error("[ws] flush send failed:", error.message);
  }
}

function handleClientFrame(ws, raw) {
  const frame = safeParse(raw);
  if (!frame || typeof frame !== "object") return;
  const op = String(frame.op || "");
  switch (op) {
    case "ping": {
      try {
        ws.send(JSON.stringify({ op: "pong", ts: Date.now() }));
      } catch {}
      return;
    }
    case "ack": {
      const messageId = String(frame.id || frame.messageId || "");
      const ackStatus = String(frame.status || frame.ackStatus || "received");
      if (!messageId) return;
      try {
        ackPulledMessage({ userId: ws.userId, messageId, ackStatus });
      } catch (error) {
        console.error("[ws] ack failed:", error.message);
      }
      return;
    }
    case "presence": {
      ws.presence = {
        state: String(frame.state || ""),
        assistantId: String(frame.assistantId || ""),
        since: Date.now(),
      };
      return;
    }
    case "subscribe": {
      flushPendingForUser(ws.userId, ws);
      return;
    }
    case "message_create": {
      // 单条消息落库（替代批量 /api/sync/push 的实时通道）。
      // 入参字段同 sync-push 的 turn schema：
      //   { id, assistantId, sessionId, role, content, createdAt, toolCallsJson?, toolCallId?, toolName? }
      // 落库后，user-role 触发 cancel pending long-term + scheduleNextPushPlan。
      handleMessageCreate(ws, frame);
      return;
    }
    case "message_update": {
      // 编辑既有消息内容。memory_item 同步 re-embed，facts 不改（让 AI 后续 memory-correct 再修）。
      handleMessageUpdate(ws, frame);
      return;
    }
    case "message_delete": {
      // 级联删 turn + memory_items / facts / edges / vectors / outbox_events。
      // 删完跨端广播 message_deleted（排除发起端）让其它设备清本地 DB。
      handleMessageDelete(ws, frame);
      return;
    }
    default:
      return;
  }
}

function ackOk(ws, op, extras = {}) {
  try {
    ws.send(JSON.stringify({ op, ok: true, ts: Date.now(), ...extras }));
  } catch {}
}

function ackErr(ws, op, error, extras = {}) {
  try {
    ws.send(JSON.stringify({ op, ok: false, error, ts: Date.now(), ...extras }));
  } catch {}
}

function handleMessageCreate(ws, frame) {
  const turn = frame.turn || frame.message || frame;
  const requiredFields = ["id", "assistantId", "sessionId", "role", "content"];
  for (const f of requiredFields) {
    if (typeof turn?.[f] !== "string" || !turn[f].length) {
      // content 允许 "" 但 role 必须 string；后端 ingest 会再做 sanity
      if (f === "content" && typeof turn?.content === "string") continue;
      return ackErr(ws, "message_persisted", `missing_${f}`, { id: turn?.id || null });
    }
  }
  const turns = [{
    id: turn.id,
    assistantId: turn.assistantId,
    sessionId: turn.sessionId,
    role: turn.role,
    content: turn.content,
    createdAt: Number(turn.createdAt) || Date.now(),
    toolCallsJson: turn.toolCallsJson || undefined,
    toolCallId: turn.toolCallId || undefined,
    toolName: turn.toolName || undefined,
  }];
  let result;
  try {
    result = ingestTurnsBatch({ deviceId: ws.deviceId || `ws:${ws.userId}`, turns });
  } catch (e) {
    return ackErr(ws, "message_persisted", e.message || String(e), { id: turn.id });
  }
  const detail = result.details?.[0] || { status: "unknown" };
  ackOk(ws, "message_persisted", {
    id: turn.id,
    status: detail.status,
    reason: detail.reason || null,
  });

  // user-role 触发器：发事件，订阅者处理 cancel / state / scheduleNextPush
  if (turn.role === "user" && detail.status !== "rejected") {
    for (const [assistantId, stats] of result.perAssistantStats) {
      if (stats.userTurnCount <= 0) continue;
      turnEvents.emitUserBatch({
        assistantId,
        userId: ws.userId,
        cause: "ws.message_create",
        stats: {
          userTurnCount: stats.userTurnCount,
          lastUserAt: stats.lastUserAt,
          lastUserContent: stats.lastUserContent,
        },
      });
    }
  }
}

function handleMessageDelete(ws, frame) {
  const id = String(frame.id || frame.messageId || "");
  if (!id) return ackErr(ws, "message_deleted", "missing_id", { id: null });
  let result;
  try {
    result = deleteConversationTurnCascade(id, {
      actor: "user",
      reason: "ws.message_delete",
    });
  } catch (e) {
    return ackErr(ws, "message_deleted", e.message || String(e), { id });
  }
  if (!result.found) {
    return ackErr(ws, "message_deleted", "turn_not_found", { id });
  }
  ackOk(ws, "message_deleted", { id, deleted: result.deleted });

  // 跨端同步：广播给同账号其它在线 socket（排除发起端，发起端已经本地删过了）。
  try {
    broadcastToUser(
      ws.userId,
      { op: "message_deleted", id, ts: Date.now() },
      { exclude: ws }
    );
  } catch (e) {
    console.error("[ws] message_deleted fanout failed:", e.message);
  }
}

function handleMessageUpdate(ws, frame) {
  const id = String(frame.id || frame.messageId || "");
  const newContent = String(frame.content || frame.newContent || "");
  const assistantId = frame.assistantId ? String(frame.assistantId) : null;
  if (!id || !newContent) {
    return ackErr(ws, "message_updated", "missing_id_or_content", { id });
  }
  let result;
  try {
    result = updateConversationTurnContent({ id, newContent, assistantId });
  } catch (e) {
    return ackErr(ws, "message_updated", e.message || String(e), { id });
  }
  if (!result.found) {
    return ackErr(ws, "message_updated", result.reason || "not_found", { id });
  }
  ackOk(ws, "message_updated", { id, memoryUpdated: result.memoryUpdated });
}

function attachSocketHandlers(ws) {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (data) => {
    try {
      handleClientFrame(ws, data);
    } catch (error) {
      console.error("[ws] handle frame error:", error.message);
    }
  });
  ws.on("close", () => unregister(ws.userId, ws));
  ws.on("error", (err) => {
    console.error("[ws] socket error:", err.message);
  });
}

function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/api/ws")) {
      socket.destroy();
      return;
    }
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    const apiKey = url.searchParams.get("apiKey") || req.headers["x-api-key"];
    const userId =
      url.searchParams.get("userId") || req.headers["x-user-id"] || "";
    if (config.requireApiKey && apiKey !== config.appApiKey) {
      socket.destroy();
      return;
    }
    if (!userId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = userId;
      register(userId, ws);
      attachSocketHandlers(ws);
      try {
        ws.send(JSON.stringify({ op: "hello", userId, ts: Date.now() }));
      } catch {}
      flushPendingForUser(userId, ws);
    });
  });

  startHeartbeatLoop();
  return wss;
}

module.exports = {
  attachWebSocketServer,
};
