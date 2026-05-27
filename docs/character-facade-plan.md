# Character Facade 实施计划

> 把 `src/services/character/` 的对外调用全部收拢到 `character/index.js`，作为事实上的独立模块边界。不改业务逻辑，纯重构。

---

## 1. 背景

### 现状

- `src/services/character/` 18 个文件、~8400 行
- 外部调用方（routes / scheduler / subscribers / proactive 自己）直接 `require('./character/identityService')` 这样按子模块名引用
- 任何内部重命名或拆分都要散改多处
- 没有单一切换点，将来要替换实现（提取独立服务、换 stub 等）成本大

### 现有参考

`src/services/proactive/index.js`（60 行）是已有的范本：
- 白名单式 export 14 项（不是全量倾倒）
- flat 风格（不分 namespace）
- 顶部注释说明模块层次

character facade 按这个标准做。

---

## 2. 目标 / 非目标

### 目标

- 所有外部代码改成 `require('../services/character')`（统一入口）
- character 子模块（`identityService`、`promptComposer` 等）变成内部细节，外部不再直接 require
- proactive 模块对 character 的依赖也走 facade，确保边界完整

### 非目标

- **不**重命名函数（保持现有调用 site 改动最小）
- **不**改 character 子模块内部结构（子模块之间互相 require 保持不变）
- **不**把 proactive 并进 character facade（proactive 自己保留独立 index.js）
- **不**做 API namespace 化（flat exports，和 proactive 一致）

---

## 3. 架构变化

### 之前

```
routes/chat.js         ┐
routes/api/*.js        │
scheduler.js           │──直接 require──► character/identityService
subscribers/*.js       │                    character/promptComposer
proactive/longTerm.js  │                    character/registerRouter
proactive/nextPush.js  ┘                    character/behaviorPlanner ...
```

### 之后

```
routes/chat.js         ┐
routes/api/*.js        │
scheduler.js           │──require──► character/index.js ──► 内部子模块
subscribers/*.js       │              （白名单 facade）
proactive/longTerm.js  │
proactive/nextPush.js  ┘
```

---

## 4. 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| API 风格 | **flat exports** | 与 proactive/index.js 一致；调用 site 改动最小（只换 require 路径） |
| 暴露范围 | **白名单** | 只 export 外部实际用到的函数；防止子模块内部 helper 泄漏成事实公共 API |
| facade 位置 | `src/services/character/index.js` | Node.js 惯例；`require('./character')` 自动指向 index |
| 子模块的"内部"标记 | 顶部加 `// @internal` 注释 | 现阶段约定即可，不引入 lint 强制 |
| proactive 并入？ | **否** | proactive 有自己的生命周期；保留 `proactive/index.js` 作为独立 facade |
| 是否修改 character 内部子模块互相 require | **否** | 内部依赖图保持不变，纯改外部入口 |

---

## 5. 实施阶段

### Phase 0 — 调用清单审计（0.5h，产物：审计 markdown）

**操作**：
```bash
grep -rn "require.*services/character/[a-z]" src/ scripts/ tests/ \
  > docs/_audit/character-callers.txt
```

**产出 `docs/_audit/character-callers.txt`**：每个外部调用方 + 它具体 require 了哪些子模块的哪些函数。

**Definition of Done**：审计文件 commit；明确**没有遗漏的调用方**。

---

### Phase 1 — 白名单设计（0.5 天，产物：API 规格文档）

**操作**：根据 Phase 0 清单，把外部用到的函数按域分组，写进 `docs/character-facade-api.md`：

| 域 | 函数 | 来源子模块 | 调用方 |
|----|------|----------|--------|
| 身份 | `getCharacterIdentity`, `upsertIdentity`, `buildIdentityPromptFragment` | identityService | chat.js, api/character.js |
| 上下文 | `buildCharacterContext` | characterContextBuilder | chat.js, api/character.js |
| Prompt | `composeForChatV3`, `composeForChatV3Default`, `renderBackgroundForIntrospection` | promptComposer | chat.js, journalService, episodeBuilder, longTerm, nextPush |
| Register | `decideRegister` | registerRouter | chat.js |
| 注意力 | `buildAttention1h` | attentionWindow | chat.js, api/character.js |
| 行为 | `evaluateBehaviorIntent`, `INTENT_DEFINITIONS`, `buildIntentPromptFragment` | behaviorPlanner | api/character.js, nextPush |
| 状态 | `applyStateDelta`, `recordCharacterStateToDB`, `buildStatePromptFragment` | characterStateService | chat.js, scheduler, longTerm, nextPush |
| 关系动态 | `getRelationshipState`, `buildRelationshipFragment` | relationshipDynamicsService | chat.js, longTerm, nextPush |
| 叙事 | `runEpisodeBuilderTick`, `listEpisodes`, `getEpisodeById`, `buildEpisodesFor` | episodeBuilder | scheduler, api/character.js |
| 反思 | `getLatestReflection`, `listReflections`, `reflectFor`, `runReflectionTickWeekly` | reflectionService | api/character.js, scheduler |
| 话题 | `listActiveTopics`, `listAllTopics`, `createTopic`, `transitionStatus`, `setImportance`, `applyDormantSweep` | persistentTopicService | api/character.js, scheduler |
| 日记 | `runDailyJournalTick`, `runWeeklyJournalTick`, `generateJournalFor`, `listJournalEntries`, `getJournalEntryById`, `updateJournalSettings` | journalService | scheduler, api/journal.js |
| 生活节拍 | `runDailyLifePlanTick`, `runLifeBeatTickOnce`, `generateLifePlanFor`, `hasLifePlanForDate` | lifePlannerService, lifeBeatTickService | scheduler, api/character.js |
| 技能 | `getSkillById` | dialogueSkillsCatalog | chat.js |
| 人格抽取 | `extractPersona` | personaExtractor | api/character.js |

> Phase 0 跑完之后用真实结果替换此表（上面是基于现有探查的草表）。

**Definition of Done**：每个 export 都至少有一个外部调用方；没有"内部 helper 误进白名单"。

---

### Phase 2 — 建 facade 文件（1.5 天）

**操作**：
1. 新建 `src/services/character/index.js`，按 Phase 1 白名单 require + module.exports
2. 顶部写注释，仿照 `proactive/index.js` 的模块层次说明
3. 跑冒烟：
   ```bash
   node -e "const c = require('./src/services/character'); console.log(Object.keys(c).sort());"
   ```
   验证：
   - 所有白名单项都在
   - 没有 `undefined` export（漏的子模块）
   - 没有循环依赖报错（Node 会 warn）
4. 跑 `npm test` —— **此时不应有任何变化**，因为没人 require facade

**Definition of Done**：
- `require('./src/services/character')` 不报错
- export 项与 Phase 1 白名单完全对应
- `npm test` 全绿（基线）

**风险点**：`characterStateService` 在 `src/services/` 根目录（不在 character/ 下），re-export 时路径要注意。如果它内部 require 了 character/ 子模块（双向），需要先确认依赖方向。

---

### Phase 3 — 调用方迁移（按风险递增，每步独立 commit）

每个文件的迁移 pattern：
```js
// Before
const { getCharacterIdentity } = require('../services/character/identityService');
const { decideRegister } = require('../services/character/registerRouter');

// After
const { getCharacterIdentity, decideRegister } = require('../services/character');
```

#### 3a. subscribers/（0.5 天）

迁移文件：
- `src/subscribers/cancelPendingPlans.js`
- `src/subscribers/scheduleNextPush.js`
- `src/subscribers/personaExtraction.js`
- `src/subscribers/characterStateUpdater.js`

**DoD**：4 个文件改完，重启服务，事件订阅日志正常触发。

#### 3b. routes/api/*.js（0.5 天）

迁移文件：
- `src/routes/api/journal.js`
- `src/routes/api/proactive.js`
- `src/routes/api/character.js`

**DoD**：前端 character / journal / proactive 三个页面打开后所有接口 200，数据正常。

#### 3c. routes/chat.js（0.5 天，热路径）

最关键一步。

**DoD**：
- `POST /api/chat/context` / `/api/chat/turn` 端到端测试通过
- Android 客户端实际聊一轮，确认 register / context / state 都正常
- 同时检查 `EffectivePromptStore` 在客户端看到的 system prompt 没变

#### 3d. scheduler.js（0.5 天）

迁移所有 character 和 proactive 相关 cron 注册。

**DoD**：重启后看到所有 cron 注册日志一致；至少跑一遍 daily-journal / proactive-watchdog 验证。

#### 3e. proactive 内部对 character 的 require（0.5-1 天）

`src/services/proactive/longTerm.js` / `nextPush.js` / `watchdog.js` 内部当前直接 require character 子模块。这一步把它们也改成走 facade，让 character facade 成为完整边界。

**DoD**：
- proactive 三个核心文件 grep `require.*character/` 应只剩 `character` 一项
- next_push 生成、watchdog tick、daily_greeting 都跑过一次验证

---

### Phase 4 — 收尾（0.5 天）

1. **子模块加 `// @internal` 注释**：18 个 character 子模块顶部各加一行：
   ```js
   // @internal — 通过 src/services/character (facade) 调用，不要直接 require
   ```
2. **CODEMAP 更新**：在 `docs/CODEMAP.md` 的"项目结构"段加一段说明：
   > `src/services/character/` 是一个独立模块，所有对外调用通过 `index.js` (facade)。子模块标记 `@internal`，不应被外部直接 require。
3. **删 Phase 0 的临时审计文件**（`docs/_audit/character-callers.txt`）—— 它的作用是过渡，不再需要

**DoD**：
- `grep -r "require.*services/character/[a-z]" src/ scripts/ | grep -v "services/character/"` 输出为空（除 character/ 内部自己 require 子模块）
- CODEMAP 更新提交

---

## 6. 工作量与排期

| Phase | 工作量 | 累计 |
|-------|--------|------|
| 0 | 0.5h | 0.5h |
| 1 | 0.5 天 | 0.5 天 |
| 2 | 1.5 天 | 2 天 |
| 3a | 0.5 天 | 2.5 天 |
| 3b | 0.5 天 | 3 天 |
| 3c | 0.5 天 | 3.5 天 |
| 3d | 0.5 天 | 4 天 |
| 3e | 0.5-1 天 | 4.5-5 天 |
| 4 | 0.5 天 | 5-5.5 天 |

**总计：5-5.5 天**，按 Phase 串行做。

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 循环依赖（facade ↔ characterStateService） | Phase 2 起步即卡 | Phase 2 第一步先跑冒烟；如有循环，把 characterStateService 也挪进 character/ 目录或拆 helper |
| 热路径 3c 出 bug | 聊天端崩溃 | 改完立刻人工跑一轮聊天 + 看日志；上线后 30min 内紧盯错误日志 |
| 漏迁移的调用方 | facade 边界不完整 | Phase 0 grep 作为基线；Phase 4 再 grep 一次回验 |
| 白名单缺函数 | 调用方迁移时报 `undefined is not a function` | Phase 1 白名单逐项核对调用方需求；Phase 3 每步先在 dev 跑 smoke |
| proactive 改完后跑挂（3e） | 主动消息整体停摆 | 3e 单独一个 commit；改完观察一晚 watchdog / daily_greeting 是否照常触发 |

---

## 8. 回滚策略

- 每个 Phase 一个独立 commit，每个 sub-phase（3a-3e）也一个独立 commit
- 任意一步出问题：`git revert <commit>` 立刻回滚到上一稳态
- Phase 2 加 facade 但不删旧 require —— 因此 Phase 3 之前任何时间点回滚都零损伤
- Phase 4 删审计文件、加注释这种纯文档动作，不在风险路径上

---

## 9. 后续可能演进（本次不做）

- 把 `characterStateService.js` 从 `src/services/` 根目录挪进 `src/services/character/`，统一物理位置
- 加 ESLint rule 强制禁止外部 `require('./services/character/[a-z]+')`
- character facade 改 namespaced API（`char.identity.get(...)`），为将来抽 HTTP 服务做准备
- `package.json` `exports` 字段配置，把 character 当 sub-package 暴露
