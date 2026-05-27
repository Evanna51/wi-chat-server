# Character Life Beat 系统 — 实施 Plan

> 取代 catchupService 的 "角色独立时间线" 重构。
> 状态：2026-05-24 立项 / **Phase 1-3 完成**（catchup 删除 + life-beat 全链路上线 +
> intimacy_outreach driver + tests/docs 落地）。后续观察生产数据再决定要不要做额外
> 调优（例如 importance 分布的人工校准）。

## 核心模型

**daily-life-plan**（每天 1 次，LLM 生 schedule） + **life-beat-tick**（每 15min 扫到点的 beat） —— 取代 catchupService。

```
04:00 cron ─→ 给每个 active 角色生成今日时间表（10-20 个 beat）
                ↓ 存 character_life_beat（pending）
*/15 cron ─→ 扫 scheduled_at ≤ now 的 pending beat
                ↓ 落 memory_items（autonomous / anchored）
                ↓ 如果 anchored + importance ≥ 阈值 + 当前独处
                    → scheduleNextPushPlan(reason='life_event_seed', seed)
                ↓ 如果聊天活跃中 → 只入库不触发 proactive，等下一轮 chat 注入
```

睡眠时段（identity / `assistant_profile.life_sleep_hours`）→ LLM 生 plan 时该段为空，tick 不会有 beat 触发。

---

## 数据库（migration 035）

```sql
CREATE TABLE character_life_beat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assistant_id TEXT NOT NULL,
  plan_date TEXT NOT NULL,             -- 'YYYY-MM-DD' 本地
  scheduled_at INTEGER NOT NULL,        -- ms epoch
  activity TEXT NOT NULL,               -- "在公司楼下买咖啡"
  beat_type TEXT NOT NULL,              -- 'autonomous' | 'anchored'
  reach_seed TEXT,                      -- anchored 时填
  importance REAL DEFAULT 0.5,
  status TEXT DEFAULT 'pending',        -- pending/activated/skipped/expired
  activated_at INTEGER,
  memory_item_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(assistant_id, plan_date, scheduled_at)
);
```

`memory_items.memory_type` 新增 `life_event_autonomous`（加进 `ALLOWED_MEMORY_TYPES`，retrieval `DEFAULT_TYPES` 排除，`source='character'` 包含）。

`assistant_profile` 加 `life_sleep_hours TEXT`（如 `'23:00-07:30'`，nullable，LLM fallback 自行判断）。

---

## 文件改动

### 新增

- `src/db/migrations/035_character_life_beat.sql` + `assistant_profile.life_sleep_hours` ALTER
- `src/services/character/lifePlannerService.js` —— 生成今日 beat 时间表（取 identity / state / 周几 / 用户 facts / 昨日 beat 总结）。prompt 视角："这是你今天的一天，按你的身份和作息列出 10-20 个具体时刻 + 在做什么"
- `src/services/character/lifeBeatTickService.js` —— 扫到点 beat → 入库 → 判断是否触发 proactive
- `scripts/run-life-planner.js` —— 手动给某角色跑今日 plan（debug 用）

### 修改

- `src/scheduler.js` — 注册 `daily-life-plan`（`0 4 * * *`，LLM_TTL 1h）+ `life-beat-tick`（`*/15 * * * *`，SHORT_TTL 5min）
- `src/config.js` — 加两个 cron env + `LIFE_BEAT_CHAT_ACTIVE_WINDOW_MS`（默认 10min）+ `LIFE_BEAT_ANCHORED_24H_SOFT_CAP`（默认 4）
- `src/db.js` — `ALLOWED_MEMORY_TYPES` 加 `life_event_autonomous`；加 life_beat CRUD prepared
- `src/services/memoryRetrievalService.js` — `DEFAULT_TYPES` 排除 autonomous；`source='character'` 包含两种
- `src/services/proactive/nextPush.js` — 支持 `reason='life_event_seed'` + `seed` 参数，prompt 加 "**当下契机**" 段（seed 内容）
- `src/services/proactive/watchdog.js` — 删 `WATCHDOG_LIFE_EVENT_FAST_GAP_MS` 路径（被 beat tick 替代），只留 72h 续链兜底
- `src/services/character/characterContextBuilder.js` — 注入 "当前 beat"：取最近 1 个 `activated` beat（同一时段 ≤ 2h 内），按 `importance ≥ 0.4` 过滤，拼一段 "你刚才/此刻在 X"
- `src/routes/api/character.js` — 加 `GET /character/life-plan/today`（debug 查看）；删 `POST /character/catchup`（返回 410 + deprecation header，给 Android 看到错误后顺势 cleanup）

### 删除

- `src/services/catchupService.js`
- `scripts/run-catchup.js`
- `scripts/audit-polluted-life-events.js`（旧污染清完后归档到 `scripts/archive/`）

### Android 端（同级目录 `../chatbox-android`）

- 不动 `ChatDtos.kt` 字段 —— 当前 beat 直接拼到现有 `chat/context` slot 里（走 `characterContextBuilder` 拼好的 system prompt 文本），客户端无感
- 删 `ChatSessionActivity` 里调 `/api/character/catchup` 的入口（hot path 之外的 lazy 调用）

---

## 触发逻辑细节

### lifeBeatTickService 决策树

```
for each pending beat where scheduled_at <= now:
  insertMemoryItem(memory_type = beat_type === 'anchored' ? 'life_event' : 'life_event_autonomous')
  mark beat activated, link memory_item_id

  if beat_type === 'anchored' AND importance >= 0.5:
    if 聊天活跃（last user/assistant turn within CHAT_ACTIVE_WINDOW_MS）:
       skip proactive trigger  → 等下一轮 chat 自然引用
    else if 24h anchored 触发数 >= SOFT_CAP:
       skip                    → 软 cap 兜底
    else:
       scheduleNextPushPlan({ reason: 'life_event_seed', seed: { activity, reachSeed, importance } })
```

### nextPush prompt seed 块（新增段）

```
当下契机（这是你刚刚的一个真实瞬间，本条主动消息应该围绕它展开）：
- 时刻: 08:14
- 你在: 在公司楼下买咖啡
- 想到 ta 的角度: 上次 ta 提过想试这家的燕麦拿铁
→ 用这个契机自然引出消息，不要硬塞，不要假设 ta 的喜好（除非用户事实里有）
```

---

## Phase 顺序

### Phase 1（基础 + 替换 catchup）
1. migration 035 + db.js prepared
2. lifePlannerService（prompt 重点：角色独立时间线 / 软 anchor / 睡眠空白）
3. lifeBeatTickService + 两个 cron
4. memoryRetrieval `life_event_autonomous` 接入
5. 删 catchupService + `/character/catchup` 路由 + 脚本

### Phase 2（proactive + chat 联动）
6. nextPush 加 `life_event_seed` reason
7. characterContextBuilder 注入 current beat
8. watchdog 清掉 fast-gap 路径

### Phase 3（收尾）
9. `GET /character/life-plan/today` debug 端点
10. 旧 life_event 污染数据清理脚本（last run + archive）
11. behavior_journal 加 `life_plan_tick` / `life_beat_tick` runType
12. tests（lifePlanner 生成结构 / tick 状态机 / proactive seed 注入）

---

## 几个要 double check 的点

- **TZ**：plan_date 按 `Asia/Shanghai` 本地日；scheduled_at 存 ms epoch。`getHours()` 已是本地（ecosystem.config.js 强制 TZ），不要用 `toISOString()`。
- **昨日尾巴**：daily-life-plan 跑时先 `UPDATE character_life_beat SET status='expired' WHERE status='pending' AND plan_date < today`。
- **首次激活角色 / 当天补跑**：如果今天 04:00 前角色才被建出来，加个 fallback —— 任何 chat hot path 检测到 `today` 无 plan 就 lazy 触发一次（带 SHORT_TTL lock 防并发）。
- **importance**：让 LLM 在生成 beat 时一起判断（0-1），约束"独处 + anchored + importance ≥ 0.5"才进 proactive，避免每个 anchored beat 都发消息。
- **catchup 删除前**：先确认 Android `chatbox-android` 里调 `/api/character/catchup` 的点只有 lazy 补叙路径，没有在 boot / chat hot path 卡死的依赖。
