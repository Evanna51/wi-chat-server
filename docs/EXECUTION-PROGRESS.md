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

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| B1 | Migration 011：character_state 增列（mood/relationship/energy/focus 共 11 列） | ✅ | 7df9f27 |
| B2 | 新建 src/services/characterStateService.js：读/写/衰减/关系升降/prompt 片段 | ✅ | f9609ca |
| B3 | 触发逻辑接入：report-interaction 后调 onUserMessage 更新状态 | ✅ | a0cc231 |
| B4 | Prompt 注入：catchupService + proactivePlanService 注入 stateFragment | ✅ | a45ca46 |
| B5 | 单测 20 个断言（Suite 1-7，含 7d 沉默衰减、情绪衰减、prompt 片段） | ✅ | 74f3ede |
| B6 | init-character-states.js 脚本（幂等，为已有 assistant 补全状态） | ✅ | 91bbf82 |
| B7 | 更新此文档阶段 B 完成 + commit | ✅ | 本次 |

**涉及文件**

- `src/db/migrations/011_character_mood.sql` — 新增 11 列
- `src/services/characterStateService.js` — 新建（327 行）
- `src/routes/api.js` — report-interaction 接入
- `src/services/catchupService.js` — stateFragment 注入
- `src/services/proactivePlanService.js` — stateFragment 注入
- `scripts/init-character-states.js` — 幂等初始化脚本
- `tests/characterState.test.js` — 20 断言测试

**关键决策**

- Phase 1 采用 heuristic 信号（关键词 + 消息长度），无 LLM 情绪分析调用，避免成本 & 延迟
- 情绪衰减在读取时惰性计算（`getEffectiveState`），无需后台扫描任务
- 沉默检测：2d→lonely，7d+level≥3→疏远，30d→软重置
- prompt 注入作为可选参数（`stateFragment`），不存在则静默跳过，零风险

**验证**

- `node tests/characterState.test.js` → 20 passed, 0 failed ✓
- `node scripts/init-character-states.js --dry-run` → 正常输出 ✓
- `node src/services/catchupService.js` (require 加载) → ok ✓

**未决/遗留**: 无（Phase 2 词库扩展已完成，见下节）

---

## 阶段 B 扩展（Phase 2）：情绪词库扩展

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| E1 | 新建 src/services/emotionTaxonomy.js：27 GoEmotions base + 95 secondary = 122 词 | ✅ | 60ff424 |
| E2 | 重写 characterStateService.js：删 EMOTION_META，接入 resolveEmotion，两段启发式 | ✅ | abeb917 |
| E3 | buildStatePromptFragment 中英对照格式"成就感 / accomplished" | ✅ | abeb917 |
| E4 | 测试：Suite 1-7 全过 + Suite 8-11 新增扩展词库测试，38 passed 0 failed | ✅ | 6bca75c |
| E5 | 端到端验证：PM2 重启 + curl 验证 accomplished/prompt 格式 | ✅ | — |
| E6 | 更新此文档 + commit | ✅ | 本次 |
| bugfix | NEGATIVE_SIGNALS 单字符误匹配修复（"特别"里的"别"） | ✅ | aeae23d |

**涉及文件**

- `src/services/emotionTaxonomy.js` — 新建（122 词，含 group/parent/valence/arousal/intensity_default）
- `src/services/characterStateService.js` — 重构（两段启发式，resolveEmotion 替代 EMOTION_META）
- `tests/characterState.test.js` — 扩展至 38 断言，11 个 Suite

**关键决策**

- 选 GoEmotions 27 作为 base（贴合对话语境，比 Ekman/Plutchik 更现代）
- 两段启发式：第一段粗分（deep_share/positive/negative），第二段关键词细化
- 无 LLM 调用：`成功/做到了→accomplished`、`感谢→thankful`、`哈哈！！→elated`、`孤独→lonely` 等依赖明确关键词，其余降级到同类默认词
- Prompt 注入 "中文 / English" 双标签，增强 LLM 对情绪的理解

**E2E 验证（Phase 2）**

```
POST /api/report-interaction { content: "项目终于成功了！太棒了，做到了！" }
→ mood_emotion=accomplished, valence=0.7 ✓
→ buildStatePromptFragment: "情绪：成就感 / accomplished（强度 40%，偏正面）" ✓
```

**未决/遗留**: 无

---

## 阶段 C: LLM Provider 抽象

**状态**: ✅ 已完成  
**开始时间**: 2026-04-28  
**完成时间**: 2026-04-28

**子任务**

| # | 任务 | 状态 | Commit |
|---|------|------|--------|
| C1 | 建 src/llm/：ILLMProvider JSDoc + index.js 工厂 + QwenProvider.js | ✅ | ca78721 |
| C2 | FakeProvider.js 测试用（setResponse/queueResponse/getCallLog） | ✅ | ebc2f72 |
| C3a | catchupService → getProvider().complete() | ✅ | da41572 |
| C3b | proactivePlanService → getProvider().complete() | ✅ | 6e68190 |
| C3c | proactivePlanService config 引用修复 | ✅ | a519ddb |
| C3d | memoryDecisionService → getProvider().complete() | ✅ | 3ef88bd |
| C3e | lifeMemoryService → getProvider().complete() | ✅ | e68842e |
| C3f | proactiveMessageDecisionService → getProvider().complete() | ✅ | cd948ae |
| C4 | embeddingService → getEmbedProvider().embed() | ✅ | 71a35cf |
| C5 | migration 012 provider_call_log + QwenProvider recordProviderCall | ✅ | 97a4248 |
| C6 | .env.example 加 LLM_PROVIDER / LLM_EMBED_PROVIDER | ✅ | 4e2aa7f |
| C7 | ClaudeProvider.js + OpenAIProvider.js 最小 stub | ✅ | 4e2aa7f |
| C8 | 集成验证：10 模块加载测试全通过 | ✅ | — |
| C9 | 更新此文档阶段 C 完成 + 整体收尾汇总 + commit | ✅ | 本次 |

**涉及文件**

- `src/llm/ILLMProvider.js` — 接口定义（JSDoc typedef + 抽象基类）
- `src/llm/QwenProvider.js` — Qwen 实现（complete + embed fallback + healthCheck + token 估算）
- `src/llm/FakeProvider.js` — 测试用假 provider（可控 response queue）
- `src/llm/ClaudeProvider.js` / `src/llm/OpenAIProvider.js` — 最小 stub
- `src/llm/callLogger.js` — provider 调用日志（惰性建表，兼容旧 DB）
- `src/llm/index.js` — 工厂 + 单例缓存 + 测试注入接口
- `src/db/migrations/012_provider_call_log.sql` — 新表
- `src/services/catchupService.js` — 迁移至 provider
- `src/services/proactivePlanService.js` — 迁移至 provider
- `src/services/memoryDecisionService.js` — 迁移至 provider
- `src/services/lifeMemoryService.js` — 迁移至 provider
- `src/services/proactiveMessageDecisionService.js` — 迁移至 provider
- `src/services/embeddingService.js` — 迁移至 provider（精简至 10 行）
- `src/config.js` — 加 llmProvider / llmEmbedProvider

**关键决策**

- `responseFormat: "json"` 自动将 temperature 强制为 0，避免 JSON 格式错误
- callLogger 惰性建表 + 静默降级：migration 012 未应用时不崩溃
- QwenProvider embed 失败时 fallback 到 `deterministicEmbedding`（sha256 → float 数组），保证向量化链路不中断
- `_setProviderForTesting()` / `_resetProviders()` 供测试 DI，不污染生产单例

**验证**

- 10 模块加载测试全通过（catchup / proactivePlan / memoryDecision / lifeMemory / proactiveMessageDecision / embedding / llm/index / QwenProvider / FakeProvider / callLogger）✓
- PM2 进程 online，内存 86 MB，无异常重启 ✓

**未决/遗留**: 无

---

## 已完成阶段总览

| 阶段 | 描述 | 完成时间 | Commit 数 |
|------|------|---------|-----------|
| A | 自动备份（增量 + 全量 + 恢复 + scheduler 接入） | 2026-04-28 | 5 |
| B | 角色状态机 MVP（migration + service + 触发 + prompt + 测试） | 2026-04-28 | 6 |
| B.2 | 情绪词库扩展（GoEmotions 27+95=122 词，两段启发式，中英 prompt）| 2026-04-28 | 4 |
| C | LLM Provider 抽象（接口 + Qwen + Fake + 5 处迁移 + embedding + call log） | 2026-04-28 | 11 |

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
