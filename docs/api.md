# API 文档（当前状态）

> **本文件是 wi-chat-server 当前在线 API 的权威清单。**
> 历史改造过程见 [archive/api-redesign-plan.md](archive/api-redesign-plan.md)（已归档）。
> 不写"过渡 / 向后兼容"——旧端点已物理删除，本文只列**现在能调的**。

## 路由挂载

| Mount | Router 文件 |
|---|---|
| `/api` | [src/routes/api.js](../src/routes/api.js) + [src/routes/chat.js](../src/routes/chat.js) |
| `/api/sync` | [src/routes/sync.js](../src/routes/sync.js) |
| `/api/browse` | [src/routes/browse.js](../src/routes/browse.js) |
| `/api/ws` | [src/ws/server.js](../src/ws/server.js)（WebSocket upgrade）|
| `/admin` | [src/routes/admin.js](../src/routes/admin.js) |

鉴权：除 `/api/health` 和部分 admin debug 端点外，所有端点均要求 `x-api-key` header（值来自 `config.appApiKey`）。

---

## §1 客户端使用（chatbox-Android）

这部分是 Android 客户端 ([ChatServerApi.kt](../../chatbox-Android/app/src/main/java/com/example/aichat/sync/ChatServerApi.kt) + [MemoryToolApi.kt](../../chatbox-Android/app/src/main/java/com/example/aichat/sync/MemoryToolApi.kt)) 实际调用的端点。**改这部分必须同步动 Android。**

### 1.1 健康检查

#### `GET /api/health`
- **用途**：网络可达性探测，门控 WS 连接和 sync drain。
- **调用时机**：`HomeNetworkCallback` 网络变更时。
- **入参**：无
- **出参**：`{ ok: true, ts }`

### 1.2 角色 boot（静态 slots）

#### `GET /api/character/:id`
- **用途**：拉角色静态 slots（profile + identity + 5 个 rendered slot：role / character / background / constraints / tool_protocol）+ etag。
- **调用时机**：App 启动 / 切换角色时。客户端长缓存到 etag 失效。
- **入参**：path `id` = assistantId
- **出参**：`{ profile, identity, renderedSlots, etag, ts }`
- **失败**：404 = assistant_profile_not_found
- **代码**：[chat.js:82](../src/routes/chat.js)
- **客户端**：`ChatServerApi.getCharacter(assistantId)`

### 1.3 每轮发消息 hot path

#### `POST /api/chat/context` ⭐ V3 ROUTER 路径（2026-05-10 上线，含 router 合并 tool 决策）
- **用途**：每轮发消息前调。服务端跑 register router（本地 LLM 决策），同时输出 register / skills / 信息层 / **tool 决策**。返回**已经拼装好的完整 system prompt**（`mergedSystem`），客户端直接当 system 喂 LLM。
- **流程**（最多 3 个 LLM 调用 + DB 查询）：
  1. `buildAttention1h` — 1h 滚动注意力（5min 缓存）
  2. `buildCharacterContext` — reflection / episodes / topics / salient（DB 查询）
  3. `decideRegister` — 本地 LLM 一次输出：register + skills + layers + budget + **server_tools + client_tools + query rewrite**
  4. 跑 `server_tools`（如 search_memory → retrieveMemory），结果进 facts slot
  5. `composeForChatV3` — 按决策拼 prompt（含可选的 `<tool_protocol>` slot）
- **入参**：
  ```ts
  {
    assistantId: string;        // 必须
    sessionId?: string;         // 强烈建议 — 不传 RAG 不能触发
    userInput: string;
    history?: Array<{ role: "user"|"assistant"; content: string }>; // ≤10 轮
    topK?: number;
  }
  ```
- **出参**：
  ```ts
  {
    ok: true;
    mergedSystem: string;             // ⭐ 直接当 system prompt（99% 客户端只用这个）
    assistantPrefill: string;
    enabledSlots: string[];           // router 决策本轮启用的 slot 名字（按 canonical 顺序）
                                      // 例：["role","style","voice_skills","constraints","attention_1h","avoid"]
    slots: {                          // slot 字典，每个值是 "<tag>...</tag>" 或 ""
      role, style, voice_skills, background, constraints,
      attention_1h, narrative, facts, tool_protocol, avoid
    };
    availableTools: string[];         // chat LLM 该附哪些 tools schema
    // 以下是 debug / 监控字段
    routerDecision: { register, skill_ids, budget, layers, server_tools, client_tools, reason, characterIntent };
    attention1h: { topics, innerFocus, emotionalTone, turnCount };
    memoryDecision: { shouldRetrieve, ranTools, intent?, source? };
    stateVersion, ts;
  }
  ```
  **客户端 99% 场景只看 `mergedSystem` + `availableTools`** — 别的都是 debug。
- **典型时延**：首轮 5-10s（attention 未缓存 + router LLM + 可能 RAG），后续 3-6s
- **代码**：[chat.js:120](../src/routes/chat.js)
- **客户端**：`ChatServerApi.chatContext(req)`
- **完整协议**：[client-prompt-merge-protocol.md](client-prompt-merge-protocol.md)
- **架构设计**：[register-router-design.md](register-router-design.md)
- **⚠️ 客户端必须做的**：
  - 用 `mergedSystem` 当 system prompt（**不要自己拼 facts / narrative / character 等子字段**）
  - 看 `availableTools`，非空时在 chat LLM API 请求里附对应 tools schema
  - 实现 tool loop：chat LLM emit `tool_call` → 调对应 server endpoint（如 `/api/tool/memory-recall`）→ 回传 `tool_result` → 再调 chat LLM
  - 传 `history` 字段（最近 4 轮）— router 用来判断 cold start
- **⚠️ 已删除字段**（客户端要清掉旧引用）：`facts` / `narrative` 顶层（信息已在 `mergedSystem`）/ `renderedSlots`（→ `systemSegments`）/ `salientPhrase` 顶层 / `memoryLines` / `memoryGuidance` / `etag` 缓存逻辑

### 1.4 上传一轮对话

#### `POST /api/chat/turn`
- **用途**：发完一轮（user + assistant）上传到服务端，触发 memory indexer / state 重算 / WS 广播。语义化别名 `/api/sync/push`，已被它取代。
- **调用时机**：每轮 LLM 出完结果后，同步 / drain queue 时。
- **幂等**：用同一个 turn UUID 即可。
- **入参**：`{ turns: [...], deviceId? }`
- **出参**：`{ ingested, deduped, rejected }`
- **代码**：[chat.js:263](../src/routes/chat.js)
- **客户端**：`ChatServerApi.chatTurn(req)`

#### `DELETE /api/chat/turn/:turnId`
- **用途**：删除一条消息 + cascade 清理（衍生 memory_items / facts / episode_links）+ 触发 state 重算 + WS 推 `turn_deleted` 给所有客户端。
- **调用时机**：用户在 UI 删除某条消息。
- **失败**：404 视为成功（幂等）
- **代码**：[chat.js:317](../src/routes/chat.js)
- **客户端**：`ChatServerApi.deleteChatTurn(turnId)`

### 1.5 角色 prompt 缓存（boot 用）

#### `POST /api/character/context`
- **用途**：admin / debug / boot cache 端点。返回 7 层认知态 payload + V_NEW_LEAN 8 个 slot + mergedSystem + assistantPrefill。**不带本轮 user 上下文**（无 sessionId / userInput），返回的 mergedSystem 中 facts / narrative slot 是占位。
- **调用时机**：boot 时缓存 system prompt 雏形让首条消息延迟低；hot path 走 `/api/chat/context`。
- **入参**：`{ assistantId, lastUserMessage? }`
- **出参**：完整 ctx payload（identity / characterState / emotion / relationshipDynamics / slots / mergedSystem / assistantPrefill）
- **代码**：[api.js:228](../src/routes/api.js)
- **客户端**：`ChatServerApi.characterContext(assistantId, lastUserMessage?)`、Android 缓存进 `CharacterBootstrapStore`

### 1.6 同步

#### `POST /api/sync/snapshot`
- **用途**：一次性同步 — 上传 assistants 元数据 + 一批 turns。和 `/api/chat/turn` 不同语义（snapshot 含 assistants 维度）。
- **入参**：`{ assistants, turns, deviceId? }`
- **出参**：`{ ingested, deduped, rejected }`
- **代码**：[sync.js:124](../src/routes/sync.js)
- **客户端**：`ChatServerApi.snapshotPush(req)`

#### `GET /api/sync/state`
- **用途**：拉服务端计数器（counters），客户端做 cross-check。**不是** event stream cursor。
- **入参**：query `assistantId?`、`deviceId?`
- **出参**：`{ counters, ... }`
- **代码**：[sync.js:203](../src/routes/sync.js)
- **客户端**：`ChatServerApi.syncState(assistantId, deviceId)`

### 1.7 Profile

#### `POST /api/assistant-profile/upsert`
- **用途**：创建 / 更新 assistant profile（characterName / characterBackground / 各 flag）。
- **入参**：`{ assistantId, characterName?, characterBackground?, allowAutoLife?, allowProactiveMessage?, ... }`
- **代码**：[api.js:96](../src/routes/api.js)

### 1.8 Memory Tools（agentic）

> 这两个是 LLM tool-calling 接口，客户端自己跑 tool loop 时调（路径 A，见 [api-redesign-plan.md §4](archive/api-redesign-plan.md)）。

#### `POST /api/tool/memory-recall`
- **用途**：搜索过往记忆 — 支持向量 + FTS + filter（source / kbName / time-range）。
- **代码**：[api.js:586](../src/routes/api.js)
- **客户端**：`MemoryToolApi.searchMemory(req)`、`SearchMemoryFormatter` 格式化为 LLM 友好文本
- **详见**：[ai-tool-memory-recall-and-correct.md](ai-tool-memory-recall-and-correct.md)

#### `POST /api/tool/memory-correct`
- **用途**：编辑 / 删除 / 调质量 / fact 增删 / pin。多 action 复用同一端点。
- **代码**：[api.js:681](../src/routes/api.js)
- **客户端**：`MemoryToolApi.correctMemory(req)`

### 1.9 WebSocket

#### `/api/ws?userId=xxx`
- **用途**：服务端 → 客户端实时推送（turn_deleted / state_updated / proactive_push 等）。
- **代码**：[src/ws/server.js](../src/ws/server.js)
- **客户端**：`WsClient`
- **详见**：[ws-client-integration.md](ws-client-integration.md)

---

## §2 内部使用（admin UI / cron / scripts）

这部分由 [public/app.js](../public/app.js)（admin UI）或服务端内部调用。**客户端不要依赖。**

### 2.1 Identity / Lore（admin UI 编辑页）
| Method | Path | 用途 |
|---|---|---|
| GET | `/api/character/identity` | 取 identity payload |
| POST | `/api/character/identity/upsert` | 更新 identity |
| GET | `/api/character/identity/vocab` | 受控词表（trait / attachment / mode 等下拉） |
| POST | `/api/character/extract` | LLM 辅助从对话抽取 persona |
| POST | `/api/character/lore/save` | 保存 lore（世界观 / 设定） |

### 2.2 Episodes / Topics / Reflection（admin UI 浏览）
| Method | Path | 用途 |
|---|---|---|
| GET | `/api/character/episodes` | 列叙事段 |
| POST | `/api/admin/character/build-episodes` | 手动重建 episodes |
| GET | `/api/character/topics` | 列 topics |
| GET | `/api/character/reflections` | reflection 时间线（**复数**）|
| POST | `/api/admin/character/reflect` | 手动触发反思 |
| GET | `/api/character/behavior-intent?assistantId=&withAttention=1` | 当前主推荐意图（默认带 attention1h 增强；传 `withAttention=0` 关闭对比）|
| GET | `/api/character/behavior-intent/vocab` | 14 个 intent 定义 |
| GET | `/api/character/attention-1h?assistantId=` | 1h 滚动注意力 debug（chat hot path 与 proactive intent 共享同一缓存）|

### 2.3 Life plan / Proactive（admin UI 调度）
| Method | Path | 用途 |
|---|---|---|
| GET | `/api/character/life-plan/today?assistantId=&date=YYYY-MM-DD&lazy=1` | 查角色今日 beat 时间表（lazy=1 默认，缺 plan 自动触发生成）。详见 [docs/character-life-beat-plan.md](./character-life-beat-plan.md) |
| POST | `/api/proactive/regenerate-plans` | 手动重生成主动消息计划 |
| GET | `/api/proactive/plans` | 列 plans |
| DELETE | `/api/proactive/plans/:id` | 取消 plan |

> ⚠️ **已废弃**：`POST /api/character/catchup` → 410 Gone（2026-05-24，migration 035）。角色生活记忆改由后台 `daily-life-plan` + `life-beat-tick` cron 自动生成。

### 2.4 Browse（admin UI 浏览数据）
全在 `/api/browse/*`，[src/routes/browse.js](../src/routes/browse.js)：
`assistants` / `assistants/:id` / `sessions` / `conversations` / `conversation-turns/:id` (DELETE) / `memories` / `memories/:id` (DELETE) / `journal` / `journal/:id` (DELETE) / `facts` / `facts/:id` (DELETE) / `stats` / `config` / `assistants/:id/flags` (PATCH) / `assistants/:id/profile` (PATCH)

### 2.5 Admin / Ops（脚本 + debug）
全在 `/admin/*`（注意：**不带** `/api` 前缀），[src/routes/admin.js](../src/routes/admin.js)：
`calls` / `calls/:callId` (DELETE) / `memory-metrics` / `autonomous-runs` / `debug/mock-push` / `replay-dead-letter` / `run-indexer-once` / `run-facts-backfill`

---

## §3 暂未使用（dormant）

> **保留但当前没人调。** 未来某个功能点亮时可以直接复用，不要删。
> 代码里都打了 `@dormant` 注释，搜 `grep -n "@dormant" src/routes/api.js` 即可定位。

| Method | Path | 何时会用 |
|---|---|---|
| GET | `/api/relationship/state` | 客户端如果只想刷新角色状态、不重拉整个 character bootstrap 时 |
| GET | `/api/character/episodes/:id` | admin episode 详情页 / 客户端"查看完整叙事段" |
| POST | `/api/character/topics/upsert` | admin 手工标注话题 / 运营干预 |
| POST | `/api/character/topics/:id/status` | admin 强制 close 话题等手动状态转换 |
| POST | `/api/character/topics/:id/importance` | admin 调试 / 运营干预 |
| GET | `/api/character/reflection`（单数）| 客户端读最近一次反思摘要 |
| POST | `/api/knowledge/upsert` | 知识库手动 / AI 写入功能上线时 |
| GET | `/api/knowledge/list` | 同上 |
| GET | `/api/knowledge/bases` | 同上 |
| POST | `/api/tool/knowledge-add` | AI 主动写知识库 tool 启用时 |
| POST | `/api/admin/search-fts` | ⚠️ FTS 后端可能不全（migration 020 已 drop conversation_turns_fts），复活前先检查 |

---

## §4 已删除

物理删除，不再存在。客户端调到这些路径会直接 404。

| Method | Path | 替代 |
|---|---|---|
| GET | `/api/character/bootstrap` | `GET /api/character/:id` |
| POST | `/api/character/context` 旧字段（`system` / `userPrefix` / `promptFragment`）| 用 `slots` + `mergedSystem` + `assistantPrefill` |
| POST | `/api/tool/memory-context` | `POST /api/chat/context` |
| POST | `/api/sync/push` | `POST /api/chat/turn` |
| POST | `/chat-with-memory` | （客户端自己包 tool loop）|
| POST | `/api/register-push-token` | （FCM 推送链路下线）|

---

## §5 改动须知

- **新增端点**：写在 §1（客户端）或 §2（内部）下，附调用时机和入出参。
- **下线端点**：物理删除路由 + 删本文 §1/§2 条目 + 加到 §4 删除列表 + 同步删 Android 端调用代码。**不写 deprecation 期。**
- **dormant 转活跃**：在 api.js 路由块上的 `@dormant` 注释删掉 + 移到 §1 或 §2。
- **客户端协议变更**：`POST /api/chat/context` 的 slot 协议改动需要同步更新 [client-prompt-merge-protocol.md](client-prompt-merge-protocol.md)。
