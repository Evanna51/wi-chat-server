const { WebSocketServer } = require("ws");
const config = require("../config");
const {
  register,
  unregister,
  startHeartbeatLoop,
} = require("./connections");
const {
  pullPendingMessagesForUser,
  ackPulledMessage,
} = require("../db");

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
    default:
      return;
  }
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
