# wi-chat-server 改造执行进度

> 此文档是三阶段改造的"驾驶舱"，每完成一个子任务即时更新。
> Context 满或 session 重启时，从这里继续即可。

---

## 阶段 A: 自动备份

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| A1 | 改 scripts/backup.js：月→日粒度，MAX(created_at,updated_at)，文件名 incr-YYYY-MM-DD，清理 8 天前 | ✅ | 54f880a |
| A2 | 新建 scripts/full-backup.js：VACUUM INTO data/backups/full-YYYY-Www.sqlite，清理 4 周前 | ✅ | a0bd939 |
| A3 | 新建 scripts/restore.js：--from <full> --apply <incr...>，按时间 upsert | ✅ | 47108f5 |
| A4 | src/scheduler.js 加 daily_incr_backup (0 3 * * *) + weekly_full_backup (30 2 * * 0)，带 leader lock | ✅ | 1923601 |
| A5 | .env.example 补 BACKUP_DAILY_CRON / BACKUP_WEEKLY_CRON / 保留窗口配置 | ✅ | f22cc59 |
| A6 | .gitignore 加 data/backups/ | ✅ | f22cc59 |
| A7 | README.md 增加"备份与恢复"小节（带具体命令示例） | ✅ | f22cc59 |
| A8 | 手动跑 full-backup + backup 验证产出（不 commit） | ✅ | — |
| A9 | 更新此文档阶段 A 完成 + commit | ✅ | 本次 |

**涉及文件**

- `scripts/backup.js` — 改造（月→日，MAX time col，自动清理）
- `scripts/full-backup.js` — 新建（VACUUM INTO + 周命名 + 清理）
- `scripts/restore.js` — 新建（全量 + 增量恢复，带安全备份）
- `src/scheduler.js` — 加两个 cron runner + exports
- `src/config.js` — 加 backupDailyCron / backupWeeklyCron 等 6 个配置项
- `.env.example` / `.gitignore` / `README.md` — 配套文档

**关键决策**

- 全量备份目录统一改为 `data/backups/`（复数），与原 `data/backup/`（旧增量）区分
- 增量 `since` 采用固定 `now - 25h`（有 1h 重叠），不依赖状态文件，更易推断
- VACUUM INTO 在 scheduler cron 中运行时使用 writable db 连接
- 全量备份已存在时跳过（幂等），scheduler 重启不会重复写
- `require.main === module` 保护：scripts 被 scheduler require 时不触发 CLI 入口

**验证结果**

- `node scripts/full-backup.js` → `full-2026-W18.sqlite` 276 KB ✓
- `node scripts/backup.js daily` → `incr-2026-04-28.jsonl.gz` 20 B（0 行，数据早于 25h 窗口，正常）✓
- `node scripts/backup.js verify incr-2026-04-28.jsonl.gz` → `{"ok":true}` ✓
- `node -e "require('./src/scheduler')"` → 加载正常，无副作用 ✓

**未决/遗留**: 无

---

## 阶段 B: 角色状态机 MVP

**状态**: 待办  
**开始时间**: —  
**完成时间**: —

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| B1 | Migration 011：新建 character_state_v2 字段集（mood/relationship/energy/focus） | 待办 | — |
| B2 | 新建 src/services/characterStateService.js：读/写/衰减/关系升降 | 待办 | — |
| B3 | 触发逻辑接入：lifeMemoryService / proactivePlanService / catchupService 跑完后更新状态 | 待办 | — |
| B4 | Prompt 注入：角色生成入口插入 mood + relationship + focus 片段 | 待办 | — |
| B5 | 单测：模拟"用户三天没回"事件验证衰减 | 待办 | — |
| B6 | 现有 assistants 写默认初始状态 | 待办 | — |
| B7 | 更新此文档阶段 B 完成 + commit | 待办 | — |

**关键决策**: 见 docs/character-state-machine-plan.md Phase 1 字段集  
**未决/遗留**: 待阶段 A 完成后确认

---

## 阶段 C: LLM Provider 抽象

**状态**: 待办  
**开始时间**: —  
**完成时间**: —

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| C1 | 建 src/llm/：ILLMProvider JSDoc + index.js 工厂 + QwenProvider.js | 待办 | — |
| C2 | FakeProvider.js 测试用 | 待办 | — |
| C3 | 迁移 5 处 chat completion 调用（每处单独 commit） | 待办 | — |
| C4 | 迁移 embeddingService.js → provider.embed() | 待办 | — |
| C5 | QwenProvider 加 token 计数 + provider_call_log 表（migration 012） | 待办 | — |
| C6 | .env.example 加 LLM_PROVIDER / LLM_EMBED_PROVIDER | 待办 | — |
| C7 | ClaudeProvider.js + OpenAIProvider.js 最小 stub | 待办 | — |
| C8 | 集成验证：主动消息生成 + 记忆生成 + 向量化链路通 | 待办 | — |
| C9 | 更新此文档阶段 C 完成 + 整体收尾汇总 + commit | 待办 | — |

**关键决策**: 见之前 chat 中的 LLM Provider 抽象方案  
**未决/遗留**: 待阶段 B 完成后确认

---

## 已完成阶段总览

| 阶段 | 描述 | 完成时间 | Commit 数 |
|------|------|---------|-----------|
| A | 自动备份（增量 + 全量 + 恢复 + scheduler 接入） | 2026-04-28 | 5 |

---

## 前置已完成的 commits（在三阶段开始之前）

| Commit | 标题 |
|--------|------|
| 36db598 | chore: PM2 config + 运行方式文档 |
| 90812bb | docs: 重写项目阅读笔记（基于 main-win） |
| 0988544 | fix(p0): 补 fetch 超时 helper，替换全部裸 fetch 调用 |
| 5da84d6 | fix(p0): SIGTERM/SIGINT 退出等待从 100ms 改为 8s |
| 2ed696c | fix(p0): REQUIRE_API_KEY 默认值改为 0，与 .env.example 对齐 |
| f521496 | chore: 默认关闭 proactiveMessageCron 旧路径 |
| f9c7fb1 | docs: 个人 AI 数据库能力缺口与建设路线图 |
