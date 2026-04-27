#!/usr/bin/env node
const WebSocket = require("ws");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--user") out.user = args[++i];
    else if (a === "--api-key") out.apiKey = args[++i];
    else if (a === "--host") out.host = args[++i];
    else if (a === "--port") out.port = args[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage: node scripts/ws-test-client.js --user <userId> [--api-key <key>] [--host <host>] [--port <port>]
Defaults: host=192.168.5.7, port=8787, api-key=dev-local-key, user=default-user`);
}

const args = parseArgs();
if (args.help) { usage(); process.exit(0); }
const userId = args.user || "default-user";
const apiKey = args.apiKey || "dev-local-key";
const host = args.host || process.env.WS_HOST || "192.168.5.7";
const port = args.port || process.env.WS_PORT || "8787";

const url = `ws://${host}:${port}/api/ws?apiKey=${encodeURIComponent(apiKey)}&userId=${encodeURIComponent(userId)}`;
console.log(`[ws-test] connecting ${url}`);

const ws = new WebSocket(url);
let pingTimer = null;
let exiting = false;

ws.on("open", () => {
  console.log("[ws-test] connected");
  ws.send(JSON.stringify({ op: "subscribe", userId }));
  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: "ping", ts: Date.now() }));
    }
  }, 25000);
});

ws.on("message", (data) => {
  const text = typeof data === "string" ? data : data.toString("utf8");
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log("[ws-test] <-", JSON.stringify(parsed));
  if (parsed && parsed.op === "queued_batch" && Array.isArray(parsed.messages)) {
    for (const m of parsed.messages) {
      const ackFrame = { op: "ack", id: m.id, status: "received" };
      ws.send(JSON.stringify(ackFrame));
      console.log("[ws-test] ->", JSON.stringify(ackFrame));
    }
  } else if (parsed && parsed.op === "proactive" && parsed.id) {
    const ackFrame = { op: "ack", id: parsed.id, status: "received" };
    ws.send(JSON.stringify(ackFrame));
    console.log("[ws-test] ->", JSON.stringify(ackFrame));
  }
});

ws.on("close", (code, reason) => {
  console.log(`[ws-test] closed code=${code} reason=${reason || ""}`);
  if (pingTimer) clearInterval(pingTimer);
  if (!exiting) process.exit(0);
});

ws.on("error", (err) => {
  console.error("[ws-test] error:", err.message);
});

function exit() {
  exiting = true;
  if (pingTimer) clearInterval(pingTimer);
  try { ws.close(1000, "client_exit"); } catch {}
  setTimeout(() => process.exit(0), 200);
}

process.on("SIGINT", exit);
process.on("SIGTERM", exit);
