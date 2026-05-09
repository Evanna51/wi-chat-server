# 角色自驱行为 + 主动消息推送 重构方案

## 背景

现有两个机制都是 **time-driven**：
- `LIFE_MEMORY_CRON='*/30 * * * *'` 每半小时让 LLM 模拟一条角色生活记忆
- `PROACTIVE_MESSAGE_CRON='*/10 * * * *'` 每十分钟评估是否要给用户发主动消息
- phone 通过 `GET /api/pull-messages` 轮询取消息

问题：

1. **Time-driven 浪费**：用户不在的 8 小时里 cron 跑了 16 次 life tick + 48 次 proactive tick，绝大部分产生 `shouldPersist=false`，纯算力浪费；服务关机期间又完全空白
2. **轮询低效**：手机后台间歇性 HTTP 请求，电量、流量、延迟都不优；推到手的消息平均比"AI 决定发"晚 5-10 分钟
3. **服务端盲推**：cron 不知道用户当前在不在 chat，可能在用户正打字时插一条主动消息
4. **不可控的"AI 生活"**：cron 跑 24/7，半夜 3 点也在生成"角色在睡觉"的废记忆，污染检索

## 新心智模型

> Lazy over eager · Push over pull · Event-driven over time-driven

三件事重做：

1. **角色自驱"生活"**：从"持续模拟"改成"用户回来时按需补叙"——只有有人看的时候才生成
2. **主动消息触发**：从"时间片轮询决定"改成"基于事件 + 计划表"
3. **消息送达**：HTTP 轮询 → **WebSocket 长连**，离线时入队，重连一次性 flush

---

## 设计 1：角色生活记忆 = Lazy Catchup

### 触发点

不跑 cron。phone 在以下时刻**显式调用** `POST /api/character/catchup`：
- 用户在 chat 界面发了第一句、且距上次 user turn > 1 小时
- daily sync 完成后（一天累积一次集中补叙）
- 用户手动按"刷新角色状态"按钮（管理面板已有触发位）

### 接口

```
POST /api/character/catchup
body: {
  assistantId: string,
  lastInteractionAt: number,    // unix ms
  now?: number,                 // 默认 server now
  maxEvents?: number            // 默认 5，最多 8
}
response: {
  ok: true,
  windowMs: <now - lastInteractionAt>,
  generated: 3,                 // 实际生成数
  memories: [
    { id, memoryType, content, createdAt }
  ]
}
```

### 服务端逻辑（伪代码）

```
gap = now - lastInteractionAt
if gap < 60min: return { generated: 0 }            # 太短没必要
nEvents = clamp(round(gap / 90min), 1, maxEvents)  # 每 90 分钟塞一条左右
prompt 给 LLM：
  - 角色背景
  - 最近 6 条对话
  - 最近 6 条 life/work 记忆
  - 时间窗 [lastInteractionAt, now]
  - 要求：生成 nEvents 条 plausible 行为，按时间顺序铺在窗口里，
    每条带绝对时间戳（在窗口内随机但保持先后顺序）
  - 输出 strict JSON array
逐条 insertMemoryItem(memoryType=life_event|work_event, createdAt=具体时刻)
触发 outbox 索引（已有）
写一条汇总进 character_behavior_journal（run_type='catchup_tick'）
```

### 优点

- 算力按需消耗：用户不打开 → 0 调用
- 服务关机期间不会丢——重启后下一次 catchup 自动覆盖空白期
- 生成的事件**有真实时间戳**而不是"刚刚生成"，时序检索更准
- `character_behavior_journal` 不再被半夜废 tick 灌水

### 弃用

- `LIFE_MEMORY_CRON` → 设为 `off` 默认，保留 env 可恢复
- `runLifeMemoryTick` 的 cron 调用入口移除；函数本身保留但仅供 catchup 服务复用其 prompt 构造逻辑

---

## 设计 2：主动消息 = 计划表 + 事件触发

### 核心：从"该不该发"切到"什么时候发"

不再每 10 分钟问一次"现在该不该发"，而是**计划 + 执行分离**：

1. **计划生成（每天 1 次，phone-driven 或服务端 daily cron）**：扫所有 `allow_proactive_message=true` 的角色，对每个评估"未来 24h 内有没有理由发一条"。有的话往新表 `proactive_plans` 写一行，含**预定发送时刻** `scheduled_at`、intent、draft

2. **执行（轻量定时器，每分钟扫一次表）**：到点了 → 通过 WS push 给 user；WS 不在线 → 写 `local_outbox_messages` 兜底队列；user 当前在 chat 里（30 秒内有 user turn）→ 推迟 30 分钟重排

3. **取消条件**：用户在 plan 执行前主动跟 AI 聊过 → plan 自动 cancel（"我已经在跟你说话了，不用主动来")

### 触发理由（plan 生成时的判断）

| 理由 | 阈值 |
|------|------|
| 长时间无互动 | `daysSinceLastInteraction >= 7` |
| 之前聊到的承诺 | 上次对话提取出 follow_up 钩子（"下次告诉你结果"），到了约定时间 |
| 关键日期 | `memory_facts` 中存的生日/纪念日，前一天 / 当天 |
| 节奏型问候（可选） | 用户在 profile 里勾选"早安/晚安"，按 quiet hours 排 |

每条 plan 生成时一并生成 draft 文本（用 LLM 一次调用），存到 `proactive_plans.draft`。这样执行的时候**不再调 LLM**，零延迟，且支持"提前看到 AI 想发什么"的管理 UI 能力。

### 新表

```sql
CREATE TABLE proactive_plans (
  id TEXT PRIMARY KEY,                     -- uuid v7
  assistant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,            -- inactive_7d | followup | birthday | greeting
  intent TEXT NOT NULL,                    -- snake_case
  draft_title TEXT,
  draft_body TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,           -- unix ms，预定发送时刻
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | cancelled | failed
  cancelled_reason TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_proactive_plans_scheduled ON proactive_plans(status, scheduled_at);
CREATE INDEX idx_proactive_plans_assistant ON proactive_plans(assistant_id, created_at DESC);
```

### 弃用

- `PROACTIVE_MESSAGE_CRON` → 设为 `off`
- `runProactiveTick` 函数保留但只被新的 plan 生成器复用其 prompt
- `local_outbox_messages` **不删**，作为 WS 不在线时的兜底队列继续承担可靠投递

---

## 设计 3：消息通道 = WebSocket

### 协议

路径：`ws://<host>:<port>/api/ws`

鉴权：握手时 query 参数 `?apiKey=<x-api-key>&userId=<user>` 或 header `x-api-key` + `x-user-id`。

握手成功后 server 把 `(userId → socket)` 加进内存 map。同 user 多设备：维护 `userId → Set<socket>`，全部 broadcast。

### 帧格式（JSON over text frame）

#### Server → Client

**主动消息**：
```json
{
  "op": "proactive",
  "id": "uuid",
  "assistantId": "...",
  "sessionId": "...",
  "title": "...",
  "body": "...",
  "messageType": "character_proactive",
  "payload": {...},
  "createdAt": 1777200000000
}
```

**flush 队列**（连接建立后立即推送积压消息）：
```json
{ "op": "queued_batch", "messages": [<proactive>...] }
```

**心跳响应**：
```json
{ "op": "pong", "ts": 1777200000000 }
```

#### Client → Server

**心跳**：每 25s 一次
```json
{ "op": "ping", "ts": 1777200000000 }
```

**ack 收到**：
```json
{ "op": "ack", "id": "<message-id>", "status": "received" }
```

server 收到 ack → 把对应 `local_outbox_messages.status='acked'`。

**presence**（可选）：手机告诉 server "用户当前在 chat 界面"
```json
{ "op": "presence", "state": "active|background", "assistantId": "..." }
```

server 用这个状态决定是否推迟 plan 执行：`active` 时不打扰。

### 连接生命周期

1. App 启动 → 尝试连 WS，**只在判断为家中 WiFi 时**（health 探活通过即认为可达）建连
2. 连上后立即 `subscribe`：发一条 `{"op":"subscribe","userId":"..."}` 触发 server 检查并 flush 积压
3. 心跳 25s/次，server 50s 没收 ping 则关闭连接
4. 断开后指数退避重连：1s, 2s, 4s, 8s, 30s 上限
5. 移动数据网络下不主动连（避免长连流量），完全依赖 WS 不在线 → 兜底队列 → 下次 daily sync 拉

### 服务端实现

依赖：`ws` npm 包（轻量、无 framework 绑定）。

```js
const { WebSocketServer } = require("ws");
const wss = new WebSocketServer({ server });  // 复用 express http server
```

挂在 `/api/ws` 路径，`server.on('upgrade', ...)` 路由。

实现要点：
- 一个 `connections.js` 模块管理 `userId → Set<ws>` map
- 暴露 `broadcastToUser(userId, frame)` 给 plan executor 调
- WS 关闭时清理 map 条目
- 进程退出 hook：所有 socket 发 `{"op":"server_shutdown"}` 后 close

### 兜底：WS 不在线时

执行 plan 时：
```
const sockets = connections.get(userId)
if (sockets.size > 0):
  for ws of sockets: ws.send(frame)
  enqueueLocalOutboxMessage(... status='acked')   # 或不进 outbox 直接 sent
else:
  enqueueLocalOutboxMessage(... status='pending') # 进队列等下次连
```

WS 重连 → server 在 subscribe handler 里 `pullPendingMessagesForUser(userId)` 一次性 flush 成 `queued_batch` 帧。

`/api/pull-messages` + `/api/ack-message` HTTP 接口**不删**，给：
- 用户在外网完全无 WS 的过渡期使用
- 备用回退（WS 实现 bug 时降级路径）
- 测试便利

---

## Daily sync 串起来

phone 每天的同步现在是这样一组动作（一次性、原子性失败可重入）：

1. `POST /api/sync/push` 推昨日累积的 turns（已实现）
2. 对每个有过对话的 assistant：`POST /api/character/catchup`（新）
3. `POST /api/proactive/regenerate-plans`（新，可选）触发服务端重新生成未来 24h 的 plan 表
4. 建立 WS 连接（如果在家中 WiFi），等待 server flush

第 3 步也可以省，让 server 自己每天 1 次内置 cron 跑 plan 生成（这一个 cron 是真有价值的，留下）。

---

## 数据库变更

| 表/列 | 操作 |
|------|------|
| `proactive_plans`（新） | migration 010 |
| `local_outbox_messages` | 不动 |
| `conversation_turns` / `memory_items` | 不动 |
| `character_behavior_journal` | 新增 `run_type` 取值 `catchup_tick` / `plan_generation_tick`，不需要 schema 改 |
| `assistant_profile` | 不动 |

env 配置：
```
LIFE_MEMORY_CRON=off
PROACTIVE_MESSAGE_CRON=off
PLAN_GENERATION_CRON=0 6 * * *      # 每天早 6 点生成未来 24h plan
PLAN_EXECUTOR_INTERVAL_MS=60000     # 每分钟扫一次到期 plan
WS_HEARTBEAT_TIMEOUT_MS=50000
WS_PING_INTERVAL_MS=25000
```

---

## API 摘要

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/character/catchup` | 按需补叙角色生活 |
| POST | `/api/proactive/regenerate-plans` | 触发 plan 表重建（可选） |
| GET | `/api/proactive/plans?assistantId=&status=` | 看 plan 列表（管理 UI 用） |
| DELETE | `/api/proactive/plans/:id` | 取消未发 plan |
| WS | `/api/ws` | 长连推送通道 |
| POST | `/api/sync/push` | 已有，daily sync 推 turns |
| POST | `/api/report-interaction` | **deprecated**，标记保留过渡期 |
| GET | `/api/pull-messages` | **fallback**，保留作为 WS 不可用时的降级路径 |

管理面板增加：
- 角色管理 Tab：新增"重新生成今日 plan"按钮
- 新一个全局 "Proactive Plans" 顶级 tab：看待发 plan、点取消、看 sent_at

---

## Phase 划分

每个 Phase 一个 subagent 任务，自包含。

### Phase A：lazy catchup（约半天）

- migration 不需要
- 新文件 `src/services/catchupService.js`，封装 LLM 调 + 多条 memory 时序铺写
- 新路由 `POST /api/character/catchup`
- `src/scheduler.js` 移除 life cron 注册（保留函数）；`.env.example` `LIFE_MEMORY_CRON=off`
- `scripts/run-catchup.js` 手动触发工具
- e2e：替一个 assistant 跑 catchup，验证 N 条 life_event 进库且 createdAt 分散在窗口里

### Phase B：proactive plans 表 + 生成器（约半天）

- migration 010 建 `proactive_plans` 表
- 新文件 `src/services/proactivePlanService.js`：
  - `generatePlans({ assistantId? }) → planIds[]` 走 trigger 评估 + 一次 LLM 出 draft
  - `cancelPlansForAssistantSinceUserActive(assistantId, threshold)` 用户活跃时调
- 新路由 `/api/proactive/*`（regenerate / list / cancel）
- 新 cron `PLAN_GENERATION_CRON='0 6 * * *'`
- `report-interaction` / `sync/push` 写入时调用 cancel（用户活跃即取消未发 plan）
- 弃用 `PROACTIVE_MESSAGE_CRON`

### Phase C：WebSocket 通道（约 1 天）

- 装 `ws` 包
- 新文件 `src/ws/connections.js`、`src/ws/server.js`
- 改造 `src/index.js` 把 express server 注入 WSServer
- 心跳、subscribe、ack、presence 全部实现
- 替换 plan executor 的发送逻辑：先 broadcastToUser，失败再入 outbox
- 重连 flush：subscribe handler 触发一次 `pullPendingMessagesForUser` 推 `queued_batch`
- 测试：用 `wscat` 或简易 node 客户端跑端到端

### Phase D：管理面板 + 文档收尾（约半天）

- 管理 UI：新增 Plans tab + 角色页"重新生成 plan"按钮
- README 加 WS 协议描述
- `docs/android-sync-integration.md` 加一节 WS 客户端集成指南
- 标记 `/api/report-interaction` 为 deprecated（README + 接口返回 `Deprecation: true` header）
- 整理 e2e 脚本

---

## 风险与边界

1. **WS 跨网络**：移动数据下运营商可能断长连。设计上**默认只在家中 WiFi 连**，移动网络仍走 daily sync + outbox 兜底。这是有意识的取舍：长连只服务"在家"场景。

2. **server 单进程**：现 schedulerLockService 是为多进程兜底。新设计单进程足够，lock service 可保留不删，但不再是必需。

3. **LLM 成本**：catchup 单次调用比 cron 整天突突跑节省不少；plan 生成 1 天 1 次也节省。整体 LLM 成本预计降到现在的 1/10 左右。

4. **plan 排程冲突**：同一 assistant 同一时段多条 plan？生成器里加去重——同 trigger_reason 24h 内只一条。

5. **多设备同 user**：WS 同 user 多 socket，全部 broadcast；ack 只要任一 socket 回，整个 user 的状态就标 acked。

6. **冷启动**：服务首次启动，没有任何 plan 也没有 catchup 过——下一次用户来 chat 时自然触发 catchup；plan 生成等到第一次 daily cron 跑（最多 24h 后）。可接受。

7. **time-driven plan executor 跟整个"event-driven"的口号自相矛盾？**：plan 表本质是事件队列，executor 每分钟扫只是 dispatch loop，跟 cron 评估"该不该发"是两件事。可以理解为"事件驱动 + 队列调度"。

---

## 不在本方案范围

- 端到端加密 / 服务端鉴权升级（仍然 API key）
- 多用户系统（仍假设 1 server : N assistants : 1 user）
- AI 主动发起音频 / 图片消息（纯文本）
- 跨服务同步（多台 server 之间共享 plan）
