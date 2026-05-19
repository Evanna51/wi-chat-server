# Register Router 设计文档

> **2026-05-10 落地**
> 让本地 LLM 决定每轮对话的"形状"——register、voice skills、信息层组合、输出预算。
>
> 核心动机：production system prompt 5656 chars 是负贡献，[ablation](../tmp/voice-ablation-1778399571540.md) 证实在简单情绪 case 上膨胀，且 narrative slot 1655 chars 超 800 cap。
> Router 让 prompt **按需扩张**：闲聊 600 chars、引用过去 1100、长咨询/RP 1500+。

---

## 1. 时间尺度梳理

| 层 | 尺度 | 内容 | 数据源 |
|---|---|---|---|
| Salient phrase | 当前一句 | 1 个关键短语 | salientPhraseDetector.js |
| **Attention 1h** | **过去 1 小时** | **关键词 + 当前心绪 latched on + 整体基调** | **attentionWindow.js（新）** |
| Active topics | 几天 | 7 状态机 topics | persistentTopicService |
| Recent episodes | 1-2 周 | 叙事段（含 unresolved threads）| episodeBuilder |
| Reflection | 月级 | 关系反思 | reflectionService |
| Identity / Lore | 永久 | 人格底色 | character_identity / profile.lore |

Attention 1h 填补"现场 vs 沉淀"的空隙——对话刚抛出什么、角色刚 latched on 什么。模型最缺的就是这层。

---

## 2. 模块结构

```
src/services/character/
├── attentionWindow.js          ← 新：1h 滚动注意力
├── dialogueSkillsCatalog.js    ← 新：16 skills 工厂
├── registerRouter.js           ← 新：本地 LLM 决策层
├── promptComposer.js           ← 加 composeForChatV3
└── (其他不动)

src/routes/
└── chat.js (POST /api/chat/context) ← 待接入：调 router → V3 composer
```

### 2.1 attentionWindow.js

**输入：** assistantId, now (默认 Date.now)

**逻辑：**
1. 拉最近 1h conversation_turns（最多 30 条）
2. 1 次本地 LLM (Qwen) 调用 → JSON
3. 内存缓存 5 min（per assistantId）

**输出：**
```json
{
  "topics": ["...", ...],         // ≤5 个 3-12 字短语
  "innerFocus": "...",             // ≤60 字角色 latched on
  "emotionalTone": "calm|intimate|tense|playful|heavy|probing|reconnecting",
  "turnCount": number,
  "ts": number
}
```

**降级：** LLM 失败 → 返回空 payload（不阻塞 chat）

**实测延迟：** Qwen 9b 本地约 2-4 秒（首次）；缓存命中 0ms

### 2.2 dialogueSkillsCatalog.js

**16 个通用 skills** 按 lengthClass 分三组：

| lengthClass | 渲染策略 | 示例 skill |
|---|---|---|
| short | 直接给真实例句 | reactive_minimal / shared_silence / fragmented_speech |
| medium | 真实例句 | empathic_mirror / shared_recall / boundary_assertion |
| **long** | **不给完整例句，给 structureSkeleton** | philosophical_volley / wordless_affection / narrative_scene_build |

> **关键设计：long 类不放完整例句**——避免话题污染。
> 比如 philosophical_volley 不给 "[150 字深度回应]" 当样本，而给 "1) 短句重定义关键词 2) 追问层面归属 3) 留白等对方接 / 整体 30-60 字"。

**角色覆盖机制：**
- catalog 是基础库（80%）
- `identity.skills` 同 id 提供专属 examples（20% 覆盖）
- 角色独有 skill（catalog 不存在）保留为 custom

**API：**
- `getSkillById(id, identity)` — 单条（合并覆盖）
- `listSkillsForRegister(register, identity)` — 候选列表
- `listAllSkills(identity)` — 全部（router 用，给 LLM 看候选清单）
- `renderSkillForPrompt(skill, opts)` — 渲染单条进 prompt

### 2.3 registerRouter.js

**输入：**
```js
{
  userInput,
  history,              // 最近 turn 列表
  available: {          // 哪些层有数据（true/数字>0）
    attention_1h, narrative_reflection, narrative_episodes,
    narrative_topics, narrative_salient,
    lore_background, facts_core, facts_retrieved,
  },
  identity,
  characterIntent,      // 启发式 evaluateBehaviorIntent 输出（2026-05-10 新增）
                        // { intent, urgency, contentHint, suggestedSocialMode } | null
                        // 让 router 知道"角色当前内心倾向"，决定 register/skills 时与之对齐
}
```

**LLM 调用：** Qwen 本地，T=0.1，max_tokens=250

**输出 JSON：**
```js
{
  register: "反应型|闲聊|情绪倾诉|引用过去|长咨询|RP",
  skill_ids: ["...", ...],   // 1-2 个
  layers: {                   // 每层 0|1（lore_background 0|1|2）
    attention_1h, narrative_reflection, narrative_episodes,
    narrative_topics, narrative_salient,
    lore_background, facts_core, facts_retrieved
  },
  budget: "short|medium|long",
  reason: "≤30 字 debug"
}
```

**降级：** LLM 失败 → 启发式 fallback（输入长度 + 时间词 + named entity 规则）

**实测延迟：** 本地 9b 约 2-3 秒；可与 attention_1h 并行

### 2.4 promptComposer.composeForChatV3

V3 slot 顺序（与 V_NEW_LEAN 不同）：

```
<role>          标记角色 + voice anchor      永远有
<style>         speaking_style 一句          永远有
<voice_skills>  router 选的 1-2 个           永远有
<background>    lore，按 layer 决定 0/短/长   按需
<constraints>   仅 hard_boundaries           按需（identity 有就有）
<attention_1h>  topics + innerFocus + tone   按需（默认有）
<narrative>     reflection/episodes/topics   按需（router 选哪些子项）
<facts>         coreFacts + retrieved        按需
<avoid>         AI tell 反模式               永远有
[prefill]       客户端独白（V3 默认不放）     可选
```

`<character>` JSON 全字段（V_NEW_LEAN 的 trait/values/care_languages）**不再注入**——这些信息已经分散到 `<role>` + `<style>` + `<voice_skills>` + reflection narrative。直接 dump JSON 是 V_NEW_LEAN 的 token 浪费源。

`<tool_protocol>` slot 也不放——chat-only 不需要 tool 决策（如果客户端要走 tool 循环，由客户端 SDK 拼）。

---

## 3. 决策流程（一次完整调用）

```
POST /api/chat/context { userInput, ... }
    ↓
[并行] ────────┬──────────────────────────────
               ↓                              ↓
    buildAttention1h(assistantId)       buildCharacterContext(assistantId)
    （5min 缓存命中 → 0ms              （拉 reflection / episodes / topics / salient）
     未命中 → LLM 2-4s）
               ↓                              ↓
               └──┬───────────────────────────┘
                  ↓
    evaluateBehaviorIntent(assistantId, { attention1h })
    （启发式，~10ms — 复用已 await 的 attention，不打 LLM）
                  ↓
    characterIntent: { intent, urgency, contentHint, suggestedSocialMode }
                  ↓
    available 矩阵 ←── 哪些层有数据
                  ↓
    decideRegister({ userInput, history, available, identity, characterIntent })
    ← LLM 2-3s（一次输出 register + skills + layers + budget + tools + query rewrite）
                  ↓
    decision: { register, skill_ids, layers, budget, server_tools, client_tools, reason }
                  ↓
    [并行] ────────┬──────────────────────────────
                   ↓                              ↓
    跑 server_tools（如 search_memory）      skills = decision.skill_ids.map(getSkillById)
    结果进 retrievedMemories
                  ↓
    composeForChatV3({ profile, identity, decision, skills, attention1h, ... })
                  ↓
    response: { mergedSystem, systemSegments, facts, narrative,
                routerDecision (含 characterIntent), attention1h, availableTools, ... }
```

**Tip**: chat path 跑的 attention1h 也会被 proactivePlanService 后续 cron 复用（5min 缓存）——
两条路径共享同一份 1h 现场感，避免重复 LLM 调用。

**总延迟：** 首轮 ~5-7s（attention + router 串行最差）；缓存命中 ~3s；可优化到 attention/router/retrieve 三路并行

---

## 4. Ablation 实测结果

[详细数据](../tmp/voice-ablation-v3-1778403085014.md)。摘要：

| Case | V1 NAKED | V3 LIGHT | V4 LEAN | **V5 ROUTER** | router decision |
|---|---|---|---|---|---|
| D1 cold "在吗" | 28 | 2 | 22 | **2** | 闲聊+reactive_minimal+short |
| E2 cold "我慌了" | 253 | 25 | 53 | **30** | 情绪倾诉+shared_silence+empathic |
| T1 cold "上次说的事" | 181 ❌tell | 33 | 84 | **9** | 情绪倾诉+shared_recall+empathic |
| T2 "那个人" | 147 | 11 | 72 | **18** | 引用过去+shared_recall+honest |
| E1 短质问 | 217 | 105 | 102 | 197 | 情绪倾诉+empathic+**vulnerable_admit** |
| E3 愤怒边界 | 68 | 73 | 101 | **75** | 长咨询+empathic+vulnerable |

**关键观察：**

1. **V5 在 cold start 上 hallucinate 防护最好** — T1 cold 时 V5 「记得。你说你慌了。」直接用 attention_1h 里"用户那句慌乱的金"做锚定，不像 V1 自承 AI 也不像 V4 编造"我不用'走出来'这个词"

2. **V5 的"膨胀"是设计意图** — E1 197ch 比 V3 105ch 长，是因为 router 加了 vulnerable_admit skill。输出质量更深刻（坦诚承认防御机制），跟 V_NEW_LEAN 的"无目的膨胀"不同

3. **System prompt 体积按需** — sys 范围 605（D1 闲聊）到 1594（E3 长咨询），平均 ~1100 chars，比当前 production 5656 砍 80%

4. **AI tell 命中：V5 全 0**（V1 命中 D2/T1 共 2 次"归纳对方"）

---

## 5. 接入计划

**Phase A — 已落地（本次）：**
- ✅ attentionWindow.js
- ✅ dialogueSkillsCatalog.js
- ✅ registerRouter.js
- ✅ composeForChatV3
- ✅ ablation v3 验证

**Phase B — 待接入 production（等确认）：**
- POST /api/chat/context 路由改造：
  ```js
  // 当前
  const composed = composeForChat({...});
  // 改成
  const att = await buildAttention1h(assistantId);
  const available = {...};  // 从 ctx + coreFacts 构造
  const decision = await decideRegister({userInput, history, available, identity});
  const skills = decision.skill_ids.map(id => getSkillById(id, identity));
  const composed = composeForChatV3({..., decision, skills, attention1h: att});
  ```
- 旧 `composeForChat` 保留给 admin/debug/boot cache（POST /api/character/context 仍用旧的）
- 客户端**无需改动** — 只看 mergedSystem/facts/narrative 字段

**Phase C — 后续优化：**
- 三路并行（attention + retrieveMemory + router）— 砍延迟
- attention_1h 写入持久化表（跨进程共享，不只内存缓存）
- skills catalog 扩展（按角色类型 — character / writer / coach 各有偏向 skill）
- router decision 入日志，跑一周看 register 分布 + 错分场景

---

## 6. 决策点回顾

跟 [ablation v2](../tmp/voice-ablation-1778400782542.md) 之后的对话决策：

| Q | 决策 | 落地 |
|---|---|---|
| Attention 1h 提取方式 | B：本地 LLM + JSON 输出 | ✅ attentionWindow.js |
| Skills 工厂通用 vs 角色 | 80% 通用 + 20% 角色覆盖 | ✅ catalog + identity.skills |
| Router 算法 | 小 LLM 分类 | ✅ Qwen 本地 |
| V3 prompt 结构 | 改了 | ✅ `<role>` 开头 + 多层级 |
| Skills 加载量 | 每次 1-2 个 | ✅ router 输出 ≤2 个 skill_ids |
| Skill examples 长度 | short/medium 给完整例句；long 给 structureSkeleton | ✅ lengthClass 字段 |
| 多层级权重 | LLM 决策每层 0/1（lore_background 0/1/2）| ✅ layers 矩阵 |

---

## 7. 已知问题 & TODO

- [ ] router 偏向把 narrative_* 全填 0（即便 available=true）— prompt 需要明示"什么时候应该打开 narrative"
- [ ] long-class skill 例句策略需要在更多 RP case 上验证
- [ ] router 输出的 reason 字段当前没记到日志，建议接入 production 时入数据库做后续分析
- [ ] attention_1h LLM 失败的兜底是空 payload，可考虑用 salientPhraseDetector 跑滚动窗口做 fallback
- [ ] skills catalog 当前无 unit test
