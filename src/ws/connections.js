const config = require("../config");

const userIdToSockets = new Map();
let heartbeatTimer = null;

function register(userId, ws) {
  if (!userId || !ws) return;
  let set = userIdToSockets.get(userId);
  if (!set) {
    set = new Set();
    userIdToSockets.set(userId, set);
  }
  set.add(ws);
}

function unregister(userId, ws) {
  const set = userIdToSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userIdToSockets.delete(userId);
}

function broadcastToUser(userId, frame) {
  const set = userIdToSockets.get(userId);
  if (!set || !set.size) return 0;
  const data = JSON.stringify(frame);
  let n = 0;
  for (const ws of set) {
    try {
      if (ws.readyState === 1) {
        ws.send(data);
        n += 1;
      }
    } catch (error) {
      console.error("[ws] broadcast send failed:", error.message);
    }
  }
  return n;
}

function getActiveSocketCount(userId) {
  const set = userIdToSockets.get(userId);
  return set ? set.size : 0;
}

function getActiveUserIds() {
  return Array.from(userIdToSockets.keys());
}

function startHeartbeatLoop() {
  if (heartbeatTimer) return;
  const interval = Math.max(5000, Number(process.env.WS_PING_INTERVAL_MS || 25000));
  heartbeatTimer = setInterval(() => {
    for (const [userId, set] of userIdToSockets) {
      for (const ws of set) {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch {}
          set.delete(ws);
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
      if (set.size === 0) userIdToSockets.delete(userId);
    }
  }, interval);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopHeartbeatLoop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function shutdown() {
  stopHeartbeatLoop();
  const frame = JSON.stringify({ op: "server_shutdown", ts: Date.now() });
  for (const [, set] of userIdToSockets) {
    for (const ws of set) {
      try {
        if (ws.readyState === 1) ws.send(frame);
      } catch {}
      try { ws.close(1001, "server_shutdown"); } catch {}
    }
  }
  userIdToSockets.clear();
}

module.exports = {
  register,
  unregister,
  broadcastToUser,
  getActiveSocketCount,
  getActiveUserIds,
  startHeartbeatLoop,
  stopHeartbeatLoop,
  shutdown,
};
