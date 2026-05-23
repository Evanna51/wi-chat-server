# wi-chat-server — Claude 协作说明

针对本仓库（character push server）的项目级约束。全局规则见 `~/.claude/CLAUDE.md`。

**新会话先读 `docs/CODEMAP.md`** —— 项目结构 / 关键表 / cron 一览表 / Gotchas 都在那，避免反复 grep。本文件只放"协作流程 + 必须知道的约束"。

---

## 测试残留数据 — 跑完测试必须清

`tests/*.test.js` 直接连真 DB（`data/character-behavior.db`），用 `t_cc_<TS>_<suffix>` 这样的 ID 造 fixture。
每个 test 文件自己有 `cleanupAll()`，但：

- 用 `LIKE '${TS}_%'` 只清本进程那批；
- **测试中途崩** / `cleanupAll` 未被调用，fixture 就泄漏在 prod DB；
- 当前 `characterCognition.test.js` Suite 10 的 `composer.composeForChat is not a function` 就稳定造成这种泄漏。

**每次跑完 `npm test` 必须再跑一次清理：**

```bash
npm run test:clean      # 真删（推荐 test 后总是跑）
npm run test:clean:dry  # 仅预览不删
```

底层脚本 `scripts/clean-test-data.js` 按已知测试 ID prefix（`t_cc_*` / `__t*` / `pron_*` / `c_split*` / `no_profile*`）扫所有带 `assistant_id` 的表 + episode_memory_link cascade。

**Claude 帮跑测试时的标准流程**：
1. `npm test`
2. **不管通过没通过**，紧接着 `npm run test:clean`
3. 报告测试结果时一起报「清理了 N 个 assistant + M 衍生 rows」

不要等用户提醒。看到 DB 里有 `t_cc_*` / `__t*` 等条目就主动跑一次。

---

## 数据库 / 进程

- prod DB：`data/character-behavior.db`（SQLite, WAL 模式），**生产数据在用**
- 服务端口：`8787`，绑 host 来自 `.env` 的 `HOST`（**不是** `0.0.0.0`；想从 localhost 访问需改 .env 或加 `127.0.0.1` alias）
- PM2 进程名：`wi-chat-server`；重启用 `npm run restart`，看日志 `npm run logs`
- 迁移：`src/db/migrations/*.sql`，启动时按文件名顺序自动跑（见 `src/db.js`）

## Cron / 锁

`src/scheduler.js` 用 `scheduleIfEnabled(cronExpr, label, runner, { lockTtlMs })` 注册定时任务。
所有 cron 受 `scheduler_lock` 表保护，防多 instance（PM2 restart 双进程 / dev 副本）重复触发。

- `lockTtlMs` 必须 > 预计 tick 执行时间（带余量），且 < cron 间隔
- 重 LLM 任务（episode / reflection / plan）用 1h；备份用 30min；轻量任务 5min
- 自递归调度（如 `scheduleNextPushPlan` option A）必须有独立 gap 闸门，**不能只靠 scheduler lock 兜底** —— 锁防多进程，gap 防同进程递归循环

## 主动消息 (proactive plan)

代码在 `src/services/proactive/`（2026-05-23 从单体 1430 行 `proactivePlanService.js` 拆出来）：

- `longTerm.js` — `generatePlanForAssistant` / `generatePlans`（plan-generation cron 走这里）
- `nextPush.js` — `scheduleNextPushPlan`（事件驱动 72h 链；**改这里必先读文件顶部 + 函数头注释**，watchdog 死循环坑就在这）
- `watchdog.js` — `runProactiveWatchdogOnce`（proactive-watchdog cron）
- `store.js` — `proactive_plans` 表所有读写 + `markPlanSent`（含 character_state 事务）

**绝对别忘的点**（详见 `docs/CODEMAP.md` Gotchas）：
- `scheduleNextPushPlan` 必须传 `reason` 参数（`user_event` / `watchdog` / `post_dispatch`），watchdog 路径有 pending 必须 skip，否则 30min 自己 cancel 自己造死链
- `markPlanSent` 写 `character_state.last_proactive_at` 是两道 gap gate 生效的前提，**不能拆事务**
- `scheduledAt` 必须加 jitter，dedup corpus 不能过滤 status，窗口 ≥ 48h

## 日记 / 周记 (character journal)

代码：`src/services/character/journalService.js`，表 `character_journal`（migration 034）。

- daily-journal cron 每天 10:30 写昨日，weekly-journal 周一 00:30 写上周
- 开关挂 `assistant_profile.enable_daily_journal` / `enable_weekly_journal`
- 素材取 conversation_turns + narrative_episode（周记另吃 relationship_reflection）
- `UNIQUE(assistant_id, period_type, period_start)` 防重复；**force generate 也不能覆盖已有 entry**，想重写先 SQL DELETE
- API：`/api/character/journal*`（settings / generate / list / detail），看 `routes/api/journal.js`

## 关联客户端

Android 客户端位于 `../chatbox-android`（同级目录）。

- hot path：`ChatSessionActivity.dispatchChatRequestWithRemoteContextIfEnabled()` → `POST /api/chat/context` → `ChatViewModel.doChatRequest(chatCtx)`
- 降级链：`chat/context` 成功 → 存 `ChatContextCache`；失败 → 取 TTL 内缓存；无缓存 → boot cache（`character/context` slots 拼接）
- `EffectivePromptStore`：进程内快照，记录每轮真实下发的 system prompt，供 `CharacterInfoActivity` 展示

改 `chat/context` 响应 schema 时，同步检查 `sync/ChatDtos.kt` 的 `ChatContextResponse`。

## Git

参见 `~/.claude/memory/feedback_git_rules.md`。重点：本地分支必须 tracking **同名** 远程分支，禁止 `git push origin HEAD:master`。
