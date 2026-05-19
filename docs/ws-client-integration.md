# WebSocket 客户端接入指南

> 给 chatbox-Android / 任意客户端工程师看：对接 `wi-chat-server` 的 WebSocket 通道（实时双向消息 + 主动推送）。
> 服务端实现见 [`src/ws/server.js`](../src/ws/server.js)，REST 同伴 API 见 [`README.md`](../README.md)。

---

## 1. 连接

| 项 | 值 |
|---|---|
| URL | `ws://<host>:<port>/api/ws`（HTTPS 部署用 `wss://`） |
| 默认端口 | 与 HTTP 同端口，默认 `8787` |
| 进程 | 与 HTTP server **同进程同端口**，无独立 daemon |
| 协议 | RFC 6455，子协议无 |
| 鉴权 | query string 或 header，二选一（详见 §2） |

**示例 URL**：
```
ws://192.168.5.7:8787/api/ws?userId=default-user&apiKey=dev-local-key
```

如果 `REQUIRE_API_KEY=0`（开发态）服务端不校验 apiKey，但 **`userId` 必须传**，否则握手直接被 destroy。

---

## 2. 鉴权

两种方式，server 都接受：

**A. Query 参数（推荐，方便测试）**
```
?userId=<user-id>&apiKey=<APP_API_KEY>
```

**B. HTTP Headers**
```
x-user-id: <user-id>
x-api-key: <APP_API_KEY>
```

`userId` 是 server 端的路由 key——proactive 推送会按 `userId` 分发到所有该 user 当前在线的连接（同 userId 多端登录会广播给每一条 socket）。

`apiKey` 仅在 `REQUIRE_API_KEY=1` 时强制校验。

---

## 3. 连接生命周期

```
client → ws connect (URL with auth)
         ↓
server ← upgrade ok
         ↓
server → { "op":"hello", "userId":"...", "ts":<ms> }
         ↓
server → { "op":"queued_batch", "messages":[...] }   ← 如果有积压
         ↓
─────── 双向自由收发 ───────
         ↓
任一端 close（正常 1000 / 服务端 1001 server_shutdown）
```

**握手成功立刻拿到的两帧**：
1. `hello`（确认连接）
2. `queued_batch`（如果该 userId 在 outbox 有积压消息；可能为空数组就**不会**发这帧）

客户端**不需要**在 hello 之后主动发 subscribe，server 已经自动 flush 了。subscribe 帧用于**手动重发**（详见 §6）。

---

## 4. 帧协议总览

所有帧均为 JSON，UTF-8。`op` 字段决定语义。

### 4.1 Server → Client

| op | 触发时机 | 必需 ack |
|---|---|---|
| `hello` | 握手成功 | 否 |
| `queued_batch` | 握手时若有积压 / `subscribe` 时 | 每条消息单独 ack |
| `proactive` | server 决定主动推一条消息（含 next_push 和长期 trigger） | 收到后 ack |
| `message_persisted` | 客户端 `message_create` 的应答 | 否（本身就是应答） |
| `message_updated` | 客户端 `message_update` 的应答 | 否 |
| `pong` | 客户端 `ping` 的应答 | 否 |
| `server_shutdown` | server 关进程前广播 | 否（连接即将断） |

### 4.2 Client → Server

| op | 用途 |
|---|---|
| `ping` | 心跳，建议每 25s 一次 |
| `ack` | 确认收到某条消息（push / queued_batch 中每条单独 ack） |
| `presence` | 可选，告知 server 当前用户是否在 chat 界面（影响某些行为） |
| `subscribe` | 主动让 server 重发积压消息（一般不用） |
| `message_create` | 实时单条落库（**替代** 批量 `POST /api/sync/push`，更省延迟） |
| `message_update` | 编辑已存在的消息 content（同步 re-embed memory） |

---

## 5. 关键帧详解

### 5.1 `proactive`（最重要的入站帧）

server 决定推一条主动消息时发：

```json
{
  "op": "proactive",
  "id": "<plan-id>",
  "assistantId": "019dfda1-...",
  "sessionId": "...",
  "title": "<≤20字通知标题>",
  "body": "<消息正文>",
  "messageType": "character_proactive",
  "payload": {
    "planId": "<plan-id>",
    "intent": "ask_followup|check_in|share_thought|remind",
    "anchorTopic": "<具体话题>",
    "triggerReason": "next_push|inactive_7d|daily_greeting|manual_request"
  },
  "createdAt": 1778100000000
}
```

**客户端动作**：
1. 在 chat 列表里以"角色名 + body"的形式展示（系统通知 + 写入会话历史）
2. **本地存这条 assistant 消息时，turn id 用 frame 里的 `id` 字段**（即 plan id）。服务端派发成功后会以同一 id 写一条 `assistant` role 的 conversation_turn——客户端如果之后通过 `message_create` 同步同一条，server `INSERT OR IGNORE` 自动去重，不会重复写
3. **必须 ack 回 server**，让 outbox 落地为 `acked`：
```json
{ "op": "ack", "id": "<plan-id>", "status": "received" }
```
3. 用户点开后，建议再发一次 `ack` 把 status 改为 `read`

ack 不发或丢失，server 会通过 `repullGapMs` 在下次重连时**再推一次**（防丢消息），所以 ack 是幂等的——客户端去重靠 `id`。

### 5.2 `queued_batch`（重连时积压补发）

```json
{
  "op": "queued_batch",
  "messages": [
    {
      "id": "<plan-id>",
      "assistantId": "...",
      "sessionId": "...",
      "messageType": "character_proactive",
      "title": "...",
      "body": "...",
      "payload": {...},
      "createdAt": 1778100000000,
      "availableAt": 1778100000000,
      "expiresAt": 1778186400000,
      "pullCount": 1
    }
  ]
}
```

客户端**应该按 id 去重**（之前可能已经收过同一条 push）后入库 + ack。

### 5.3 `message_create`（出站，单条落库）

替代离线批量 `POST /api/sync/push`。WS 在线时每条消息走这个，延迟 < 50ms（无 LLM 调用）。

```json
{
  "op": "message_create",
  "id": "<turn-uuid-v7>",
  "assistantId": "...",
  "sessionId": "...",
  "role": "user",
  "content": "...",
  "createdAt": 1778100000000,

  "_optional_": "tool_call/tool_result 角色才用：",
  "toolCallsJson": "[...]",
  "toolCallId": "call_xxx",
  "toolName": "search_memory"
}
```

字段语义同 [`README.md` §10.1 sync-push turn schema](../README.md#101-post-apisyncpush)。

**id 幂等**：客户端用 UUID v7 生成，重发同一 id 不会重复落库（server `INSERT OR IGNORE`）。

**server 应答**：
```json
{
  "op": "message_persisted",
  "ok": true,
  "id": "<turn-uuid-v7>",
  "status": "accepted|skipped|replaced|rejected",
  "reason": null,
  "ts": 1778100000050
}
```

| status | 含义 |
|---|---|
| `accepted` | 新写入，落库成功 |
| `skipped` | 已存在（同 id 或 logical-key 同 content），不重复处理 |
| `replaced` | 同 (assistantId, sessionId, role, createdAt) 但 content 不同 → 旧的级联删，新的写入 |
| `rejected` | 校验失败，看 reason 字段 |

**触发副作用**：当 `role=user` 且 `status≠rejected`，server 会异步触发 `scheduleNextPushPlan`（详见 [README §16.1](../README.md#161-next_push-触发链路)）。客户端无感知。

**proactive 消息的回写**：服务端派发 `proactive` 帧成功时已经自己写了一条 `assistant`-role conversation_turn（id = plan id）。客户端**不需要**主动把同一条 proactive 再发一遍 `message_create`——但如果你的本地架构是"统一所有发出消息走同一路径"，发了也无害（同 id 会被 server 跳过为 `status=skipped`）。

### 5.4 `message_update`（出站，编辑既有消息）

```json
{
  "op": "message_update",
  "id": "<turn-id>",
  "content": "<新内容>",
  "assistantId": "<assistant-id>"
}
```

`assistantId` 可选；如果传，server 会做属主校验（防止跨角色误改）。

server 应答：
```json
{
  "op": "message_updated",
  "ok": true,
  "id": "<turn-id>",
  "memoryUpdated": 1,
  "ts": 1778100000050
}
```

`memoryUpdated > 0` 表示派生的 memory_item 也同步改了 content + 标 `vector_status='pending'` 等待 indexer 重 embed。`memory_facts` 不动（旧 facts 是从旧 content 抽的，让 AI 后续用 `memory-correct` 修）。

错误响应 `ok=false` + `error` 字段：
- `not_found` — turn id 不存在
- `assistant_mismatch` — turn 不属于这个 assistantId
- `missing_id_or_content` — 字段缺

### 5.5 `presence`（可选）

```json
{
  "op": "presence",
  "state": "active|background",
  "assistantId": "<当前打开的 assistant，可选>"
}
```

server 把它存在 `ws.presence` 上，目前**只读**——没逻辑分支用它。预留未来"用户在前台时不推 proactive"等场景。

### 5.6 心跳

| 方向 | 帧 | 周期 |
|---|---|---|
| Client → Server | JSON `{"op":"ping","ts":<ms>}` | 25s |
| Server → Client | JSON `{"op":"pong","ts":<ms>}` | 收到 ping 立即回 |
| Server ↔ Client | RFC 6455 ping/pong（TCP 级，自动） | 25s |

任一周期未收到 pong，server `terminate()` 该 socket。客户端检测到断开 → 走 §7 重连。

---

## 6. 重连策略

WebSocket 不保证可靠，客户端必须有自动重连：

```
1. close 触发后，立即检测网络（不要无脑重连）
2. 网络 OK → 指数退避（1s → 2s → 4s → 8s → 30s 封顶）
3. 重连成功 → server 自动发 hello + queued_batch 补齐积压
4. 客户端 dedupe 已经入库的 id，新的入库 + ack
```

**outbox TTL**：消息默认 24h（见 `LOCAL_PULL_MESSAGE_TTL_MS`）后 expire，重连后不会再下发过期消息。

**`subscribe` 帧**：握手时已自动 flush 一次。极端场景（怀疑漏消息）可手动发：
```json
{ "op": "subscribe", "userId": "..." }
```
server 重新 flush 一次 outbox，**不会**重置 pull_count。

---

## 7. 客户端最小实现示例（JavaScript）

```js
const WS_URL = "ws://192.168.5.7:8787/api/ws?userId=default-user&apiKey=dev-local-key";

let ws = null;
let reconnectDelay = 1000;
const seenIds = new Set();

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    console.log("[ws] connected");
    reconnectDelay = 1000;
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({op:"ping",ts:Date.now()})), 25000);
  };
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data);
    switch (f.op) {
      case "hello": break;
      case "proactive":
        if (seenIds.has(f.id)) return;
        seenIds.add(f.id);
        renderInChat(f);                // 你的 UI 逻辑
        ws.send(JSON.stringify({op:"ack", id:f.id, status:"received"}));
        break;
      case "queued_batch":
        for (const m of f.messages) {
          if (seenIds.has(m.id)) continue;
          seenIds.add(m.id);
          renderInChat(m);
          ws.send(JSON.stringify({op:"ack", id:m.id, status:"received"}));
        }
        break;
      case "message_persisted":
        // 你之前 send 的 message_create 的应答；按 id 在本地标记 synced
        markSynced(f.id, f.status);
        break;
      case "message_updated":
        // message_update 应答
        break;
      case "pong":
      case "server_shutdown":
        break;
    }
  };
  ws.onclose = () => setTimeout(connect, reconnectDelay = Math.min(30000, reconnectDelay * 2));
  ws.onerror = (e) => console.error("[ws]", e);
}

// 用户发消息时调用
function sendUserMessage({ id, assistantId, sessionId, content }) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      op: "message_create",
      id, assistantId, sessionId,
      role: "user",
      content,
      createdAt: Date.now(),
    }));
  } else {
    // 离线兜底：缓存到本地，回联后走 POST /api/sync/push
    queueOffline({ id, assistantId, sessionId, content });
  }
}

connect();
```

---

## 8. WS vs HTTP 选型

| 场景 | 走 WS | 走 HTTP |
|---|---|---|
| 用户发消息（在线） | ✅ `message_create`（低延迟） | ⛔ |
| 用户离线缓存批量补 | ⛔ | ✅ `POST /api/chat/turn` |
| 接收 server 主动推 | ✅ `proactive` 帧 | ⛔（HTTP 轮询通道已废） |
| 编辑既有消息 | ✅ `message_update` | ⛔（无 HTTP 等价 endpoint） |
| 拉取关系状态/记忆 | ⛔ | ✅ `POST /api/character/context`（含 characterState）/ `POST /api/tool/memory-recall` |
| Bootstrap 单次拉所有静态 | ⛔ | ✅ `GET /api/character/:id` |

**经验法则**：实时双向 → WS；查询 / 大批量 / 离线后补齐 → HTTP。两者**复用**同一鉴权 + 同一数据库，client 不需要做"只走 WS"或"只走 HTTP"的取舍。

---

## 9. 调试工具

仓库自带一个最小 ws 客户端：

```bash
npm run ws:test -- --user default-user --api-key dev-local-key
```

可加 `--host <host>` `--port <port>`。会打印所有收到的帧，用键盘输入发送 ping / ack。

---

## 10. 故障排查

| 症状 | 可能原因 | 排查 |
|---|---|---|
| upgrade 立即被关 | URL path 不对 / userId 缺 / apiKey 错 | 看 server 日志 `[ws] upgrade rejected` |
| 收不到 proactive | 该 userId 没在线 / 该 assistant 关了 `allow_proactive_message` | `GET /api/proactive/plans?status=pending` 看是否生成 |
| `message_create` 一直 `rejected` | role 非 5 类之一 / content 非 string / 时间戳异常 | 看 `message_persisted.reason` |
| 频繁重连 | 心跳没发 / 网络不稳 | 客户端检查 ping 间隔 |
| `queued_batch` 反复推同一条 | 客户端没 ack | 收到每条 push 都要 ack |
