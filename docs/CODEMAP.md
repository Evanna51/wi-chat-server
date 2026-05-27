# wi-chat-server CODEMAP

新会话 Claude 进来先读这里，避免反复 grep。**只放稳定结构信息**，业务行为细节看 `CLAUDE.md`，单文件注释看头部。

---

## 目录速查

```
src/
  index.js              启动入口（router 挂载、scheduler、ws server）
  config.js             所有 env 配置 + cron expressions（getServerLlmConfig / getIntrospectionLlmConfig）
  db.js                 better-sqlite3 instance + 所有 prepared statement helpers（700+ 行单体，待拆）
  scheduler.js          所有 cron 注册 + plan-executor setInterval loop
  llm/                  Provider 抽象（getProvider / getEmbedProvider / getIntrospectionProvider）
  db/migrations/        按编号顺序自动执行的 SQL（启动时跑，见 db.js 顶部）
  ws/                   WebSocket 派发
  events/               EventEmitter 桥（turnEvents / profileEvents）
  subscribers/          事件订阅者（scheduleNextPush / cancelPendingPlans / personaExtraction）
  workers/              retentionSweeper / memoryIndexer
  routes/
    api.js              slim mount → api/* sub-routers（21 行）
    api/
      _middleware.js    authMiddleware（REQUIRE_API_KEY env）
      meta.js           /health、/assistant-profile、/relationship/state
      character.js      /character/identity*、episodes*、topics*、reflection*、behavior-intent、attention-1h、context、life-plan/today、extract、lore、/admin/character/*
      journal.js        /character/journal/*（日记 / 周记）
      memory.js         /tool/memory-recall、memory-correct、/admin/search-fts
      knowledge.js      /knowledge/*、/tool/knowledge-add（dormant）
      proactive.js      /proactive/plans CRUD + regenerate
    chat.js             POST /api/chat/context（chat hot path，给客户端拼 prompt slots）
    sync.js             客户端 turn 同步（/api/sync/push、/api/sync/pull）
    admin.js            /admin/* — calls / metrics / debug
    browse.js           admin UI 浏览
  services/
    proactive/          主动消息子系统（拆自原 1430 行 proactivePlanService.js）
      shared.js         工具 + LLM 调用 + 跨模块常量
      store.js          proactive_plans 表所有 prepared statement + markPlanSent 事务
      longTerm.js       inactive_7d / daily_greeting trigger + generatePlans
      nextPush.js       72h 事件驱动 + scheduleNextPushPlan
      watchdog.js       runProactiveWatchdogOnce
      index.js          重新导出 15 个公开 API
    character/          角色认知层（identity / state / dynamics / episodes / topics / reflection / behavior / journal / persona / attention / promptComposer / characterContextBuilder / lifePlannerService / lifeBeatTickService）
    memoryRetrievalService / memoryEditService / memoryIngestService / memoryClassificationService
    characterStateService / knowledgeService / characterEngine / textDedupService
tests/                  jest 测试，直连真 DB（清理脚本：npm run test:clean，见 CLAUDE.md）
scripts/                ad-hoc 脚本（dead-letter-replay / run-plan-generator / clean-test-data 等）
```

## 关键表（`data/character-behavior.db`, SQLite WAL）

| 表 | 用途 | migration |
|---|---|---|
| `conversation_turns` | 聊天回合（assistant/user role + content + session） | 001 |
| `memory_items` / `memory_facts` / `memory_edges` | 记忆三层（atomic / 抽取 facts / 关联） | 001, 013 |
| `memory_audit_log` | memory 修正动作日志 | 014 |
| `assistant_profile` | 角色配置 + 开关（`allow_proactive_message` / `enable_daily_journal` / `enable_weekly_journal` 等） | 004, 016, 032, 034 |
| `character_identity` / `character_state` | 角色身份 + 实时状态（mood / energy / intimacy / last_proactive_at） | 025, 027 |
| `narrative_episode` + `episode_memory_link` / `persistent_topic` | 叙事段 + 长期话题 | 028 |
| `relationship_reflection` | 周关系反思 | 029 |
| `proactive_plans` | 主动消息计划（pending/sent/cancelled） | 010 |
| `character_journal` | 日记 / 周记（period_type=daily\|weekly） | 034 |
| `character_life_beat` | 角色独立时间线 beat（pending/activated/skipped/expired） | 035 |
| `character_behavior_journal` | 所有 service 调度日志（debug 必看） | - |
| `scheduler_lock` | cron leader lock 防多实例 | 033 |
| `outbox_events` / `local_outbox_messages` / `dead_letter_events` | 消息派发 | - |
| `provider_call_log` | LLM 调用统计 | - |

下个 migration 编号：**036**。

## cron 任务（`config.js` *Cron env，`scheduler.js` 注册）

| label | 默认 | 干嘛 |
|---|---|---|
| `plan-generation` | `0 6 * * *` | inactive_7d / daily_greeting 长期 plan |
| `proactive-watchdog` | `*/30 * * * *` | next_push 链断了帮忙续上 |
| `daily-journal` | `30 10 * * *` | 角色日记（10:30 写昨日） |
| `weekly-journal` | `30 0 * * 1` | 角色周记（周一 00:30 写上周） |
| `daily-life-plan` | `0 4 * * *` | 给每个 active 角色生今日 beat 时间表（10-18 条 anchored/autonomous）|
| `life-beat-tick` | `*/15 * * * *` | 扫到点 pending beat → 落 memory + 视情触发 proactive seed |
| `episode-builder` | `30 3 * * *` | memory_items → narrative_episode |
| `topic-dormant-sweep` | `0 4 * * *` | 21 天没提的 topic 转 dormant |
| `reflection-weekly` | `30 4 * * 0` | 周关系反思 |
| `memory-classify-backfill` | `*/10 * * * *` | user_turn 分类 + 抽 facts（高频，看清成本） |
| `retention-sweep` | `30 3 * * *` | 清 outbox / 过期 |
| `backup-daily` / `backup-weekly` | `0 3 * * *` / `30 2 * * 0` | DB 备份 |
| `dead-letter-monitor` | `0 9 * * *` | 死信监控 |

`plan-executor` 不是 cron，是 `setInterval` loop（默认 60s，`config.planExecutorIntervalMs`）。

所有 cron 都包了 `scheduleIfEnabled` + `scheduler_lock` 防多实例。`lockTtlMs` 三档：
- **SHORT_TTL** 5min — sweep / classify / monitor
- **MEDIUM_TTL** 30min — backup
- **LLM_TTL** 1h — episode / reflection / journal / plan

## 路由 mounting（`src/index.js`）

| 路径前缀 | router | 文件 |
|---|---|---|
| `/api` | apiRouter | `routes/api.js` → `routes/api/*` |
| `/api/chat` | chatRouter | `routes/chat.js` |
| `/api/sync` | syncRouter | `routes/sync.js` |
| `/admin` | adminRouter | `routes/admin.js` |
| `/` | browseRouter | `routes/browse.js` |

API 端点风格统一：`authMiddleware`（REQUIRE_API_KEY env）+ zod schema 校验 + `{ ok: bool, ... }` 返回。

## 改 X 的时候要看 Y

| 任务 | 文件 |
|---|---|
| 加新 LLM-heavy cron | `scheduler.js`（scheduleIfEnabled + LLM_TTL）+ `config.js`（cron env） |
| 加新表 | `db/migrations/035_xxx.sql`；schema 字段同步加到 `db.js` prepared statements |
| 加新角色开关 | ALTER TABLE assistant_profile + `listProactiveAssistantProfiles` 这类 list fn 加 filter |
| 改 proactive 触发链 | `services/proactive/{longTerm,nextPush,watchdog,store}.js`，**永远先看 nextPush.js 顶部 + scheduleNextPushPlan 头部注释** |
| 改角色生活时间线 | `services/character/{lifePlannerService,lifeBeatTickService}.js` + `docs/character-life-beat-plan.md`；新加 beat type 要同步 `db.js insertLifeBeat` 校验 |
| 加新主动消息 intent | `services/character/behaviorPlanner.js`（INTENT_DEFINITIONS + evaluate）。intent-specific prompt 抗偏置写在 `buildIntentPromptFragment` 里 |
| 加新 API endpoint | `routes/api/<domain>.js`（按业务选 meta/character/journal/memory/knowledge/proactive 之一） |
| 改 chat 上下文 | `routes/chat.js` + `services/character/characterContextBuilder.js` + Android `sync/ChatDtos.kt`（同步检查） |
| 改 chat 决策 / 角色内心 | `services/character/registerRouter.js`（cognition router：inner / state_delta / register_tags / response_stance / skill_ids / layers）+ `services/character/dialogueSkillsCatalog.js`（skill catalog 增删） |
| 改 system prompt 渲染 | `services/character/promptComposer.js`（slot 新增改 `SLOT_CANONICAL` + 同步 docs/client-prompt-merge-protocol.md） |
| 切换 LLM provider | `.env` 改 `SERVER_LLM_PROVIDER` / `INTROSPECTION_LLM_PROVIDER`（fallback 链：INTROSPECTION → SERVER → qwen） |

## Gotchas（fix 过的坑别再踩）

- **watchdog 不能无脑调 `scheduleNextPushPlan`**：`reason` 参数区分 `user_event` / `watchdog` / `post_dispatch`。watchdog / post_dispatch 路径如果还有 pending 必须 skip，否则死链（每 30min 自己 cancel 自己刚生成的 plan）。见 `services/proactive/nextPush.js` 顶部 + 函数头注释。
- **`last_proactive_at` 只在 `markPlanSent` 时更新**，且必须**同 SQLite 事务**，否则 `NEXT_PUSH_MIN_GAP_FROM_LAST_MS` / `WATCHDOG_MIN_GAP_FROM_PROACTIVE_MS` 两道 gate 失效。改 markPlanSent 时别拆 transaction。
- **next_push `scheduledAt` 必须加 jitter**（±10min），否则全部落 cron tick 准点（:00 / :30），观感像机器人定时发。`evaluateDailyGreeting` 同理（5~25min）。
- **dedup corpus 别只看 `status='sent'/'pending'`**，cancelled 也要看，否则 watchdog cancel 掉的同 body 没人拦。窗口 ≥ 48h，24h 会让边界 body 复活。
- **TZ**：DB 时间戳是 ms epoch；prompt / UI 显示要用本地时间。`process.env.TZ=Asia/Shanghai` 已在 `ecosystem.config.js` 强制，所以 `Date.getX` 都按上海时间，但 `toISOString()` 仍是 UTC（错位 8h）。给 LLM 看时间用 `formatLocalTs(now)`，别用 toISOString。
- **Express 路由顺序敏感**：`/character/journal/settings` 必须在 `/character/journal/:id` 之前注册，否则被 `:id` 通配吞掉。同理 `/generate`。
- **测试中途崩 → fixture 泄漏**：跑完 `npm test` 必须 `npm run test:clean`。看到 DB 有 `t_cc_*` / `__t*` 等条目立刻清。详见 `CLAUDE.md`。
- **PM2 双实例时**：`scheduler_lock` 防 cron 重复触发，但订阅者 / API 调用没锁。靠业务层 UNIQUE 约束 / dedup 兜底（如 `character_journal` 的 UNIQUE(assistant_id, period_type, period_start)）。
- **`.claude/worktrees/*` 是临时 worktree，绝对不能 commit**。`git add -A` / `git add .` 容易把它扫进来。逐个 `git add <file>`。
- **`memory-classify-backfill` 默认 10min 一跑 50+20 行**，走 introspection provider。`.env` 设 `INTROSPECTION_LLM_PROVIDER=qwen` 走本地否则跟 `SERVER_LLM_PROVIDER` 走（云端有调用量成本）。
- **journal entry 默认不可覆盖**：`UNIQUE(assistant_id, period_type, period_start)` + service 层不删旧。force generate 也会被 UNIQUE 拦，想重写得先 SQL DELETE。
- **life beat 链路有 4 道闸门**（lifeBeatTickService 决策树）：beat_type='anchored' + importance≥0.5 + 非聊天活跃（10min 内无 turn）+ 24h anchored 触发数<4。任一不满足只入 memory_items 不触发 proactive。env：`LIFE_BEAT_CHAT_ACTIVE_WINDOW_MS` / `LIFE_BEAT_ANCHORED_24H_SOFT_CAP`。
- **autonomous beat 不进 retrieval 默认池**：`memory_type='life_event_autonomous'`，`memoryRetrievalService.DEFAULT_TYPES` 不含；只有 `source='character'` 才召回（避免污染用户 query）。
- **`intimacy_outreach` 跟主 prompt 的"必须引用具体事件"规则冲突**：buildIntentPromptFragment 在此 intent 命中时会注入显式覆盖说明，**改这块时不要清掉那段** 否则 LLM 会强行翻 life event 拼借口。
- **cognition router 的 state_delta 单轮上限**：mood_valence / intensity / energy / suppressed_intensity 各 ±0.3，intimacy ±2.0。LLM 输出超出会被 `applyStateDelta` clamp。改上限只动 `characterStateService.STATE_DELTA_CAPS` + `registerRouter._STATE_DELTA_CAPS` 两处必须一致。
- **inner_thought slot 位置在 constraints 后、attention_1h 前**：改 `SLOT_CANONICAL` 顺序时要同步 `docs/client-prompt-merge-protocol.md` 第 3 节 + chat.js / boot 的 `slots` 字典手动列表（promptComposer.js 与 chat.js 都列了一遍 slot key，漏一个客户端拿不到）。
- **state_delta 应用时机**：chat hot path 故意把 `applyStateDelta` 放在 `composeForChatV3` **之后**——本轮 prompt 用旧 state + 新 inner_thought（一致：旧状态的角色刚被这一句触动），下一轮 prompt 才看到 shift 后的新 state。**别把它挪到 compose 前**，否则会双重计算（state 已变 + inner 又描述刚变）。
