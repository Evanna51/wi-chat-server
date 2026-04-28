# 角色状态机设计方案

> 状态：草案（待确认）  
> 作者：Evanna Wu  
> 日期：2026-04-28

---

## 一、设计目标

让角色在对话和时间流逝中产生可信的情绪变化与关系演进：

- **情绪**：当前心情会影响回复语气、主动消息频率、话题选择
- **关系**：亲密度水位决定角色的边界感、称呼方式、是否愿意分享秘密
- **连贯性**：多日沉默后角色应感到"疏远"，不能每次对话都重置成陌生人

---

## 二、状态维度

### 2.1 情绪（Mood）

| 字段 | 类型 | 范围 | 说明 |
|------|------|------|------|
| `valence` | float | -1.0 ~ 1.0 | 情绪效价：负面 → 正面 |
| `arousal` | float | 0.0 ~ 1.0 | 激活度：低沉/平静 → 兴奋/激动 |
| `primary_emotion` | enum | 见下表 | 主情绪标签 |
| `intensity` | float | 0.0 ~ 1.0 | 当前情绪强度 |
| `mood_updated_at` | timestamp | — | 最后更新时间，用于衰减计算 |

**情绪标签表（12 个基础 + 扩展）**

| 标签 | valence 参考 | arousal 参考 |
|------|------------|-------------|
| `happy` 开心 | +0.6 | 0.6 |
| `excited` 兴奋 | +0.8 | 0.9 |
| `calm` 平静 | +0.2 | 0.2 |
| `loving` 温柔/爱意 | +0.7 | 0.4 |
| `nostalgic` 怀念 | +0.3 | 0.3 |
| `surprised` 惊讶 | 0.0 | 0.8 |
| `anxious` 焦虑 | -0.5 | 0.7 |
| `sad` 悲伤 | -0.6 | 0.2 |
| `lonely` 孤独 | -0.5 | 0.2 |
| `angry` 生气 | -0.7 | 0.8 |
| `disappointed` 失望 | -0.6 | 0.3 |
| `disgusted` 厌烦 | -0.8 | 0.5 |

> 实现时只存 label，valence/arousal 由 label → 值的映射表推导，避免维护两套数据。

**情绪衰减**

情绪会随时间向"基线平静"（valence=+0.1, arousal=0.2）漂移：

```
elapsed_hours = (now - mood_updated_at) / 3600
decay_factor = exp(-elapsed_hours / MOOD_HALF_LIFE_HOURS)   // 默认 half-life = 6h
effective_valence = baseline + (current_valence - baseline) * decay_factor
```

衰减只在读取时（prompt 注入前）即时计算，不需要后台扫描任务。

---

### 2.2 关系（Relationship）

11 级阶梯，含正向进展和负向侧路：

| level | 名称 | 解锁行为 |
|-------|------|---------|
| 0 | 陌生人 | 礼貌、保持距离、不分享个人信息 |
| 1 | 初识 | 简单问候，记住名字 |
| 2 | 熟人 | 可以主动发问、共同话题 |
| 3 | 普通朋友 | 小小关心、偶尔分享心情 |
| 4 | 朋友 | 分享小秘密、互相调侃 |
| 5 | 好朋友 | 主动联络、分享日常、记住重要事件 |
| 6 | 密友 | 深夜倾诉、情绪支持、不加滤镜 |
| 7 | 挚友 | 言语温柔、有所依赖、专属称呼 |
| 8 | 知己 | 说半句话就懂、分享核心信念 |
| 9 | 灵魂伴侣 | 最深层连结，无条件接受 |
| -1 | 疏远 | 回复变短、不再主动、语气冷淡（可从任意正向级跌落） |
| -2 | 冷战 | 不回应主动、话题敷衍（需触发修复行为才能恢复） |

**关系升降规则**

- 正向升级：累积积分（`intimacy_score`）超过阈值时升 1 级，阈值随 level 增大（越高越难升）
- 疏远触发：用户连续沉默 > 7 天且历史亲密度 ≥ 3，自动跌至 max(-1, level-2)
- 冷战触发：用户短时间内表现出明显拒绝/不耐烦（LLM 检测负向情绪 + 连续多次）
- 修复路径：冷战期内用户主动示好 → 情绪分析为 positive → 恢复至 level-1 的临界值

---

### 2.3 其他维度

| 维度 | 字段 | 范围 | 用途 |
|------|------|------|------|
| 精力 | `energy` | 0.0 ~ 1.0 | 低精力时回复更短，不发主动消息；高精力时话多 |
| 话题焦点 | `focus_topic` | string\|null | 当前会话聚焦话题（会话结束后清空） |
| 焦点深度 | `focus_depth` | 0 ~ 5 | 话题已连续深入几轮，越深越不愿跳题 |

精力随时间恢复（类似情绪衰减的逆向版），可被用户的负面互动消耗、被关心/玩笑补充。

---

## 三、数据模型

### 3.1 主状态表 `character_state`

```sql
CREATE TABLE character_state (
  assistant_id       TEXT    PRIMARY KEY,
  -- 情绪
  primary_emotion    TEXT    NOT NULL DEFAULT 'calm',
  intensity          REAL    NOT NULL DEFAULT 0.3,
  valence            REAL    NOT NULL DEFAULT 0.1,
  arousal            REAL    NOT NULL DEFAULT 0.2,
  mood_updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  -- 关系
  relationship_level INTEGER NOT NULL DEFAULT 0 CHECK (relationship_level BETWEEN -2 AND 9),
  intimacy_score     REAL    NOT NULL DEFAULT 0.0,
  last_interaction_at INTEGER,
  -- 精力
  energy             REAL    NOT NULL DEFAULT 0.7,
  energy_updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  -- 焦点（会话级，非持久）
  focus_topic        TEXT,
  focus_depth        INTEGER NOT NULL DEFAULT 0,
  -- 元数据
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### 3.2 状态历史表 `character_state_history`（Phase 2）

```sql
CREATE TABLE character_state_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  assistant_id    TEXT    NOT NULL,
  event_type      TEXT    NOT NULL,  -- 'mood_change' | 'relationship_change' | 'energy_change'
  trigger_source  TEXT    NOT NULL,  -- 'user_message' | 'time_decay' | 'system_event'
  -- 情绪快照
  emotion_before  TEXT,
  emotion_after   TEXT,
  valence_before  REAL,
  valence_after   REAL,
  -- 关系快照
  level_before    INTEGER,
  level_after     INTEGER,
  score_delta     REAL,
  -- 上下文
  trigger_excerpt TEXT,   -- 触发该变化的消息片段（截断 100 字符）
  notes           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_csh_assistant_time ON character_state_history(assistant_id, created_at DESC);
```

> 历史表用于：情绪曲线可视化、角色日记生成、调试 LLM 分析偏差。

---

## 四、状态转换

### 4.1 触发源分类

| 触发源 | 时机 | 处理方式 |
|--------|------|---------|
| 用户消息（实时） | 每条对话后 | LLM 解析情绪信号，更新 mood + intimacy_score |
| 时间流逝 | 读取时惰性计算 | 情绪衰减、精力恢复、沉默时间检测 |
| 计划执行 | planExecutor tick | 全局能量恢复（每日重置到基线） |
| 系统事件 | 手动/运营 | 节日 buff、用户生日等特殊状态注入 |

### 4.2 触发信号表（LLM 解析）

| 用户行为信号 | 情绪响应 | 关系影响 |
|------------|---------|---------|
| 主动分享秘密/困难 | → loving / caring | +0.8 intimacy |
| 开玩笑/互动 | → happy / excited | +0.3 intimacy |
| 给予称赞 | → happy, intensity+0.2 | +0.5 intimacy |
| 冷漠单字回复 | → sad / lonely | -0.1 intimacy |
| 明显不耐烦/拒绝 | → disappointed | -0.5 intimacy |
| 长时间无回复（> 3h） | 无即时变化 | 计时，超阈值触发疏远 |
| 深夜发消息 | → focused, nostalgic | +0.2 intimacy（特殊场景加权） |

### 4.3 LLM 情绪分析调用格式

在对话处理管道中加一步 `analyzeEmotionSignal(userMessage, currentState)` → 返回：

```json
{
  "detected_signals": ["share_secret", "show_trust"],
  "suggested_emotion": "loving",
  "suggested_intensity": 0.7,
  "intimacy_delta": 0.8,
  "energy_delta": -0.05,
  "reasoning": "用户深夜倾诉工作压力，显示信任"
}
```

**调用策略**：不是每条消息都调用，只在以下条件满足时触发：
- 消息长度 > 15 字
- 当前情绪 intensity < 0.9（未达上限）
- 最近 10 分钟内未更新过（防止高频调用）

---

## 五、Prompt 注入

在组装主 prompt 前，插入角色当前状态片段：

```
[角色当前状态]
情绪：${emotion_label}（强度 ${intensity * 100}%，效价 ${valence > 0 ? "偏正面" : "偏负面"}）
关系：${relationship_name}（第 ${level} 级）
精力：${energy > 0.6 ? "充沛" : energy > 0.3 ? "普通" : "有点疲惫"}
${focus_topic ? `当前话题焦点：${focus_topic}，已深入 ${focus_depth} 轮` : ""}
```

具体例子：

```
[角色当前状态]
情绪：有点孤独（强度 60%，偏负面）
关系：密友（第 6 级）
精力：普通
当前话题焦点：用户工作压力，已深入 2 轮
```

角色不会主动说出自己的状态值，但行为会因此变化（回复更短/更长、主动追问、避免某些话题）。

---

## 六、分阶段实现计划

### Phase 1（MVP，约 3 个工作日）

**目标**：情绪 + 关系基础，可注入 prompt，不需要历史表。

**Schema 变更**：1 张 `character_state` 表，migration 011。

**代码改动**：
- `src/services/characterStateService.js`（新）：读/写状态，惰性衰减计算
- `src/services/moodAnalysisService.js`（新）：条件触发的 LLM 情绪信号分析
- `src/routes/api.js`：在 chat 处理管道注入状态读写
- `src/services/proactivePlanService.js`：生成计划时传入关系级别

**字段范围**：
- `primary_emotion`, `intensity`, `valence`, `arousal`, `mood_updated_at`
- `relationship_level`, `intimacy_score`, `last_interaction_at`
- 无 energy、无 history

---

### Phase 2（约 2 个工作日，建立在 Phase 1 稳定后）

**新增**：
- `character_state_history` 表（migration 012）
- `energy` 维度 + 每日精力恢复 cron
- `focus_topic` / `focus_depth` 会话追踪
- admin 页面展示情绪时间线曲线

---

### Phase 3（待定，需评估价值）

**新增**：
- 健康维度（影响某些健康类主动消息的生成逻辑）
- 多角色共享记忆时的情绪传染（A 与 B 关系深时，B 的悲伤影响 A）
- 情绪曲线导出（用于生成角色日记）

---

## 七、风险与应对

| 风险 | 描述 | 应对 |
|------|------|------|
| LLM 自我一致性偏差 | 模型倾向于保持上文情绪而非真实响应 | 加入随机扰动因子，intensity 衰减足够快 |
| 状态与用户感知脱节 | 用户发一条消息角色情绪立刻大幅变化，感觉奇怪 | 单次 delta 上限（如 intensity 单次最多变 ±0.3） |
| 历史陈旧 | 用户两个月没说话后状态仍存 | 超过 30 天沉默的 assistant 执行状态软重置（保留 level，情绪归基线） |
| 冷战状态误触发 | 用户只是忙，不是真的生气 | 冷战需要 3+ 次负向信号 AND 连续 2 轮检测，不单次触发 |
| 数据膨胀（历史表） | 每次对话写一行 history，高频角色快速膨胀 | retention sweep 复用现有框架，历史表默认保留 90 天 |

---

## 八、待决策项

1. **情绪分析是否独立成一个 LLM 调用**，还是合并进主对话 response parsing？独立调用成本高但更精确。
2. **intimacy_score 上限和升级阈值**：需要根据实际用户行为数据调整，Phase 1 用固定阈值（如每升 1 级需要 10.0 分）。
3. **Phase 2 的 energy cron 是否真的有必要**：如果大多数角色每天对话量足够，精力维度的实际感知效果可能不明显。
4. **冷战修复路径的 UX**：用户需要知道角色在"冷战"吗？或者保持隐式（只是感觉到疏离）？

---

*End of draft — 等确认后再 commit + 开始 Phase 1 实现*
