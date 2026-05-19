# Frontend 拆分方案（SPA + ES Module）

> 状态：待实施（上线窗口稳定后再动）
>
> 历史：曾考虑改 MPA（多 HTML 入口），评估后放弃。结论见文末「为什么不走 MPA」。

## 背景

`public/app.js` 已近 2700 行，单文件 SPA，router/views/components 全部混在一起，难以维护。

决策：**保留单页 + hash router，把 `app.js` 拆成原生 ES Module**。不引入 React/jQuery/打包工具，零新依赖，零 build。

---

## 目标目录结构

```
public/
  index.html                       ← 唯一 HTML 入口（不动）
  style.css

  js/
    main.js                        ← 入口：startHealthPing + dispatch + hashchange
    router.js                      ← parseHash / dispatch（动态 import pages/*）
    api.js                         ← request / api / getApiKey
    utils.js                       ← formatTime / formatBytes / shortText / escapeHtml
                                       / isCharacterTypeLike / assistantTypeLabel
    el.js                          ← el() / clearRoot / showToast / startHealthPing
    zh-labels.js                   ← ZH 翻译表 + zhOf
    components/
      combo.js                     ← makeCombo / closeAllCombos
      tags-input.js                ← makeTagsInput
      dialogs.js                   ← showResultDialog / showExtractPreviewDialog
                                       / rowDeleteBtn
    pages/
      home.js                      ← viewHome
      plans.js                     ← viewPlans
      search.js                    ← viewSearch
      character.js                 ← viewCharacter（顶部 header + tab bar + assistant 缓存）
      character-overview.js        ← renderOverviewTab
      character-settings.js        ← renderManageTab
      character-conversation.js    ← renderConversationTab
      character-identity.js        ← renderIdentityTab
      character-cognition.js       ← renderCognitionTab + renderPromptPreview
      character-intent.js          ← renderIntentTab
      character-memory.js          ← renderMemoryTab
      character-facts.js           ← renderFactsTab
      character-journal.js         ← renderJournalTab
```

---

## 关键设计决策

### 1. 路由保留 hash

`#/`、`#/plans`、`#/search`、`#/character/:id/:tab` 全部不变。所有外部链接 / Android 客户端深链不动。

### 2. `router.js` 用动态 import 按需加载

```js
// router.js
const routes = {
  home:      () => import('./pages/home.js').then(m => m.viewHome()),
  plans:     () => import('./pages/plans.js').then(m => m.viewPlans()),
  search:    () => import('./pages/search.js').then(m => m.viewSearch()),
  character: (r) => import('./pages/character.js').then(m => m.viewCharacter(r.assistantId, r.tab)),
};
```

效果：首屏只下 `home.js`，进 character 才下 character 那一坨。比 MPA 还精细（MPA 是 HTML 粒度，这是模块粒度）。

### 3. `pages/character.js` 是 tab 容器

负责：
1. 拿 `assistantId` / `tab` 参数
2. 缓存 assistant：模块级 `let cachedAssistant = null`，相同 ID 切 tab 不重新 fetch
3. 渲染顶部角色头 + tab bar
4. 按 `tab` 动态 import 对应 `character-*.js` 并调用 `render(body, assistant)`

切 tab = hash 变 = `dispatch()` 重跑 = 但 `cachedAssistant` 还在，秒切。

### 4. 共享态保留

`state.health` / `state.stats` 在 `main.js` 顶层维护，所有页面共用，不需要重复 ping。

### 5. 入口

`index.html` 的 `<script type="module" src="/app.js?v=...">` 改成 `<script type="module" src="/js/main.js?v=...">`，其他不动。`app.js` 在拆分完成且验证通过后删除。

---

## 各文件预估行数

| 文件 | 预估行数 |
|---|---|
| js/main.js | ~25 |
| js/router.js | ~40 |
| js/api.js | ~55 |
| js/utils.js | ~80（含 isCharacterTypeLike / assistantTypeLabel）|
| js/el.js | ~80 |
| js/zh-labels.js | ~215 |
| js/components/combo.js | ~120 |
| js/components/tags-input.js | ~115 |
| js/components/dialogs.js | ~150（含 rowDeleteBtn）|
| js/pages/home.js | ~155 |
| js/pages/plans.js | ~165 |
| js/pages/search.js | ~110 |
| js/pages/character.js | ~85（容器 + tab dispatch）|
| js/pages/character-overview.js | ~90 |
| js/pages/character-settings.js | ~190 |
| js/pages/character-conversation.js | ~130 |
| js/pages/character-identity.js | ~270 |
| js/pages/character-cognition.js | ~280（含 renderPromptPreview）|
| js/pages/character-intent.js | ~165 |
| js/pages/character-memory.js | ~115 |
| js/pages/character-facts.js | ~50 |
| js/pages/character-journal.js | ~190 |

最大单文件 280 行（cognition），其余均在 50–200 行。

---

## 实施原则

- **纯搬运**：不改任何业务逻辑，只加 `export` / `import`
- **一次提交**：整个拆分作为一个 PR，方便 diff / 回滚
- **保留 app.js**：拆分期间新旧并存（cache-bust 版本号区分），验证通过后再删除
- 跨模块共用的工具函数（`escapeHtml` / `formatTime` 等）原地 import，不复制

---

## 为什么不走 MPA

评估过 MPA（12 个 HTML + 移除 router），放弃的原因：

1. **核心痛点是「单文件 2700 行」，不是「SPA 架构」** — 纯模块拆分已经解决这个痛点，目录结构和文件行数与 MPA 方案完全一致。
2. **character 9 个 tab 互切体验回归** — MPA 每次 reload 丢滚动位置、丢未保存表单、丢打开的 combo/dialog，且每切 tab 重新 fetch assistant。SPA 不存在这个问题。
3. **共享 header 复制到 12 个 HTML** — 加导航项要改 12 处，是 footgun。
4. **`style.css?v=...` cache-bust 在 12 个 HTML 里重复** — 改 CSS 要同步 12 处版本号。
5. **旧 hash URL 全部失效** — 收藏 / Android 深链 / 文档里贴的链接全断。
6. **首屏 JS 体积** 是 MPA 的主要卖点 — 这是本地管理台、Evanna 一个人用，没意义；动态 import 已经够用了。

MPA 在这个场景是纯成本零收益。
