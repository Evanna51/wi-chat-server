# wi-chat-server 产品方向分析

> 2026-04-28 | 未 commit，等用户确认后决定下一步

---

## 第一部分：功能 2（用户记忆库）现状盘点

### 1.1 memory_items 现有结构与内容

**表字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID v7) | 主键 |
| assistant_id | TEXT | 角色 ID |
| session_id | TEXT | 写入时的会话 ID |
| source_turn_id | TEXT | 来源对话轮次 |
| **memory_type** | TEXT | 记忆类型（见下） |
| content | TEXT | 记忆内容文本 |
| salience | REAL (0–1) | 重要度（默认 0.5） |
| confidence | REAL (0–1) | 置信度（默认 0.5） |
| vector_status | TEXT | 向量化状态（pending/done） |
| created_at | INTEGER | 写入时间戳 ms |

**真实数据中的 memory_type 分布（当前 DB）：**

| memory_type | 数量 | 说明 |
|-------------|------|------|
| `user_turn` | 4 | 用户原始输入，由 `report-interaction` 写入 |
| `life_event` | 3 | 角色生活事件，由 `catchupService` 的 LLM 生成 |
| `work_event` | 2 | 角色工作事件，同上 |

**关键发现**：现在存入 memory_items 的内容有两种来源：
1. **用户原话**（`user_turn`）——直接镜像用户消息，无任何语义归类
2. **角色生活轨迹**（`life_event` / `work_event`）——LLM 编造的角色视角日常事件

**没有**"用户的偏好"、"用户的经历"、"用户的知识收藏"等维度。

### 1.2 检索排名公式（`memoryRetrievalService.js:65–71`）

```
finalScore = semantic * 0.48
           + recency  * 0.20
           + salience * 0.15
           + confidence * 0.10
           + edgeBoost * 0.05
           + sessionBoost * 0.02
```

- **semantic**：向量余弦相似度归一化到 [0,1]
- **recency**：按 `retrievalWindowDays`（默认 30d）线性衰减
- **salience/confidence**：写入时的元数据，目前大多数记录用默认值 0.5
- **edgeBoost**：`memory_edges` 图权重，实际基本为空
- **没有按 memory_type 加权或过滤**

这意味着 `life_event`（角色自己的日常）和 `user_turn`（用户说的话）在检索时权重相同——这是隐患：当用户问"我上次提到什么"时，可能召回角色的生活事件而非用户实际说过的话。

### 1.3 catchup / proactivePlan 调记忆时是否区分类型？

- `catchupService`（`src/services/catchupService.js`）：调 `retrieveMemory()` 时**不传 memory_type 过滤**，全量召回，再靠语义相似度排序。
- `proactivePlanService`：同上，无 memory_type 过滤。
- **当前无法做到"只取用户知识收藏做总结"**——因为"知识收藏"这个类别根本不存在于 schema 中。

### 1.4 小结

| 能力 | 现状 |
|------|------|
| 存储用户说过的话 | ✅ user_turn |
| 存储角色生活事件 | ✅ life_event / work_event |
| 用户记忆按语义搜索 | ✅ 向量检索 |
| 用户记忆按类型过滤 | ❌ 无分类字段 |
| 知识收藏 / 经历 / 偏好分离 | ❌ 未实现 |
| 按时间维度做"周报/年总结" | ❌ 无时间聚合接口 |
| 提取用户关系图 | ❌ memory_edges 存在但未使用 |

---

## 第二部分：记忆分类方案设计

### 2.1 分类树（9 大类）

> 设计原则：覆盖"个人 AI 陪伴 + 个人助理"场景的高价值信息；分类之间互斥但可多标签；优先可自动推断的类。

| 中文名 | id | 典型示例 | 检索特殊性 | 可扩展字段 |
|--------|----|---------|-----------|------------|
| 闲聊记录 | `chitchat` | "今天天气真好" | recency 权重低；主要看情感信号 | sentiment_label |
| 个人经历 | `personal_experience` | "我上周去杭州出差了" | 时间/地点锚点关键；按时间轴排 | event_date, location, emotion_label |
| 关系信息 | `relationship_info` | "我妈很担心我" | person entity 是核心索引维度 | person_name, relation_type, sentiment |
| 知识收藏 | `knowledge` | "你知道 HNSWLIB 的近似度算法吗" | confidence 比 recency 更重要 | source_url, domain, confidence |
| 目标与计划 | `goals_plans` | "我今年想减肥 10 公斤" | 需要 status 跟踪（open/done/dropped） | target_date, status, progress |
| 偏好与习惯 | `preferences` | "我不喝咖啡，只喝茶" | salience 高，长期有效；防快速遗忘 | category (food/music/...), strength |
| 决策与反思 | `decisions_reflections` | "最终选了 A 方案" | 低 recency 权重但高 salience | linked_goal_id, outcome |
| 健康/情绪信号 | `wellbeing` | "最近睡眠很差，压力大" | 时序敏感，有聚合分析价值 | valence, intensity, duration_days |
| 创意与想法 | `ideas` | "要不然做一个自动总结功能？" | status=raw 为主，挖掘价值在语义聚类 | status (raw/developed/discarded) |

### 2.2 向后兼容

- `user_turn`、`life_event`、`work_event` 保留不变
- 新增 `memory_category` TEXT 列（默认 NULL 代表"未分类"）
- `user_turn` 记录可以携带 `memory_category`；`life_event/work_event` 属角色侧，不分类

### 2.3 落地方案（按复杂度递增）

**Option A（推荐 MVP）：加一列 + 写入时 LLM 分类**

```sql
ALTER TABLE memory_items ADD COLUMN memory_category TEXT;
CREATE INDEX idx_memory_items_category
  ON memory_items(assistant_id, memory_category, created_at DESC);
```

- 写入 `user_turn` 时，同时调一次轻量 LLM（Qwen/Haiku 级别，约 0.01–0.02 元/条）做分类
- prompt 约 150 tokens，JSON 输出：`{"category": "personal_experience", "confidence": 0.85}`
- 对 salience/confidence 回填分类置信度

**Option B：启发式粗分 + LLM 精分**

- 正则先过滤：时间词（上周/昨天）→ `personal_experience`，情绪词（压力/睡眠）→ `wellbeing`，疑问句 → `knowledge`
- 规则未命中的走 LLM 精分
- 成本降 60%，覆盖常见场景

**检索 API 扩展（最小改动）：**

```js
// 在 retrieveMemory() 增加可选过滤
retrieveMemory({ assistantId, query, category: "knowledge" })
// SQL: WHERE memory_category = ? (category 参数可为 null = 不过滤)
```

**历史数据回填：**

用离线脚本跑一遍现有 `user_turn`，LLM 分类后写入 `memory_category`，幂等可重复运行。

---

## 第三部分：扩展方向分析

### 方向 1：记忆分类（前置基础）
**一句话**：给 memory_items 加语义分类，让"知识收藏"和"闲聊"可以被独立检索。  
**价值**：几乎所有其他扩展都依赖它——周报需要按时间+类型聚合、决策助手需要 goals_plans、偏好个性化需要 preferences。  
**复杂度**：S（仅加一列 + 一次 LLM 调用）  
**协同**：catchup/proactivePlan 的 prompt 可以传入"用户近期偏好"，使生活事件更贴近用户  
**风险**：分类 LLM 调用的成本随用户量线性增长；需要缓存/去重策略

---

### 方向 2：时间维度回顾（周报/月报/年总结）
**一句话**：基于记忆库自动生成"你上周经历了什么、有什么感悟"。  
**价值**：将碎片化记忆聚合成用户可读的叙事，强化"AI 记住了我"的感受；也适合做产品留存（每周推送）。  
**复杂度**：M（SQL 时间聚合 + LLM 叙事生成，需要分类先行）  
**协同**：依赖 memory_category；和推送通知天然结合  
**前置**：记忆分类完成后才有实质价值  
**风险**：叙事质量强依赖记忆分类准确度；LLM 生成长文本需要控制幻觉

---

### 方向 3：偏好画像 + 被动学习
**一句话**：从对话中无感知地提取用户偏好，持续更新 preferences 记忆。  
**价值**：让角色回复越来越"懂我"——推荐内容、问候方式、话题选择都可个性化。  
**复杂度**：M（偏好抽取 + memory upsert 防重复；需要信息融合）  
**协同**：写 preferences 类记忆；proactivePlan prompt 注入用户偏好  
**风险**：偏好推断错误会降低信任感；需要用户能够更正

---

### 方向 4：关系图谱抽取
**一句话**：从用户对话中识别人名、关系、事件，建立可视化的"用户社交网"。  
**价值**：当用户提到"我朋友小李"时，角色能回忆起"上次你说小李换了新工作"。memory_edges 已有基础。  
**复杂度**：M（NER 实体识别 + 关系抽取 + 图维护）  
**协同**：丰富 relationship_info 分类；memory_edges 的 graphBoost 有实际分值贡献  
**风险**：中文 NER 准确率不稳定；人名同义词/别名处理复杂

---

### 方向 5：多模态摄入（语音/图片/文档）
**一句话**：让用户可以发图片、语音备忘录、PDF，直接进记忆库。  
**价值**：大幅扩展输入来源，使"私域 AI 数据库"真正完整。  
**复杂度**：XL（ASR + OCR + 文档解析 + 多模态向量化，基础设施投入大）  
**协同**：接入 memory_items 后检索逻辑不变  
**风险**：文件存储成本、隐私风险（图片含 PII）、iOS/Android 权限申请流程复杂  
**评估**：高潜力但不是短期方向，建议等记忆分类稳定后再考虑

---

### 方向 6：私域 RAG（记忆库作为知识源）
**一句话**：所有 LLM 调用默认先召回相关记忆作为 context，不只是 catchup/proactivePlan。  
**价值**：chat-with-memory、任意对话接口都能"看到历史"，让 AI 有"长期记忆"感。  
**复杂度**：S（memoryDecisionService 已有骨架，扩展 intent 覆盖面即可）  
**协同**：直接利用现有 retrieveMemory；memory_category 过滤可提升相关性  
**风险**：每次调用都做向量检索增加延迟（约 +50–200ms）；token 消耗增加  
**评估**：性价比最高的扩展之一，几乎是现有功能的"完成度补全"

---

### 方向 7：决策助手
**一句话**：用户面对选择时，角色基于历史偏好、经历、目标给出个性化建议。  
**价值**：从"陪伴者"升级为"顾问"，体验差异化明显。  
**复杂度**：L（需要 goals_plans + preferences + decisions_reflections 分类先行；LLM 推理复杂）  
**前置**：记忆分类、偏好画像完成才有材料  
**风险**：AI 给重大建议有伦理/法律风险（健康、财务、职业）；需明确声明不构成专业建议

---

### 方向 8：今日情绪/心理日志
**一句话**：专设入口记录情绪状态，独立于普通对话，形成情感曲线。  
**价值**：wellbeing 分类的纯化形态；对有心理健康需求的用户价值高；日后可做趋势分析。  
**复杂度**：M（独立 UI 入口 + 时序分析 + 异常检测）  
**协同**：写 wellbeing 记忆；proactive "关心消息" 基于情绪低谷触发  
**风险**：心理相关产品监管风险高；需要谨慎的话术设计，避免假共情

---

### 方向 9：角色成长可视化（关系曲线 / 情绪曲线）
**一句话**：对外提供一个 dashboard，展示与角色的关系走势、情绪历史、话题热力图。  
**价值**：增强用户和产品的情感连接；游戏化"关系养成"感。  
**复杂度**：M（纯前端 + 数据接口；后端 character_state 已有历史数据基础）  
**风险**：可视化本身不创造价值，需要配合内容丰富化（分类完成后曲线才有意义）  
**评估**：偏 polish 功能，6 个月后做比现在做更合适

---

### 方向 10：角色之间的对话（多角色社交模拟）
**一句话**：多个 AI 角色互相聊天，用户旁观或参与。  
**价值**：叙事沉浸感强，差异化明显。  
**复杂度**：XL（多 agent 协调、对话状态同步、角色一致性极难）  
**评估**：**不推荐近期做**。用户基数小时打磨多角色一致性投入产出比极低；技术风险高。等功能 2 记忆库完善后作为远期方向。

---

## 第四部分：Roadmap 综合建议

### 排序逻辑

```
记忆分类
  └─► 私域 RAG         (立即获益：任何对话都"有记忆")
  └─► 时间维度回顾      (周报留存；分类是必要前提)
  └─► 偏好画像          (个性化提升；分类中的 preferences 基础)
        └─► 决策助手    (需要偏好 + 目标数据积累)
  └─► 关系图谱          (relationship_info 分类后可实现)

多模态                  (独立投入，等上面稳定后)
情绪日志                (细分用户需求，可并行)
可视化 dashboard        (polish 层，最后)
```

---

### 3 个月：打基础、补完整

**主线**：记忆分类 + 私域 RAG

| 任务 | 理由 |
|------|------|
| 加 `memory_category` 列，写入时 LLM 分类（9 大类） | 所有后续扩展的前置；S 级改动，快速上线 |
| 历史数据回填脚本 | 确保存量数据可用 |
| 检索 API 支持 category 过滤 | 使现有 catchup/proactivePlan 可以按类型取记忆 |
| 扩展 memoryDecisionService intent → 所有对话走记忆召回 | 已有骨架，补全为真正的私域 RAG；用户体验提升最直接 |

**里程碑**：角色能在任意对话中引用"上次你说的偏好/经历"。

---

### 6 个月：增强粘性、个性化

**主线**：时间维度回顾 + 偏好画像

| 任务 | 理由 |
|------|------|
| 周报 / 月报生成 API + 推送通知集成 | 固定节点的"AI 记住了我"体验；提升留存 |
| 偏好持续提取 + 偏好注入 proactivePlan prompt | 使角色生活事件更贴近用户兴趣，减少"AI 在自说自话"感 |
| wellbeing 分类 + 情绪低谷触发关心消息 | 差异化；高用户价值的情感功能 |
| 关系图谱（NER 实体抽取 → memory_edges）| 让"小李"在不同对话间有连续性；中等复杂度但感知很强 |

**里程碑**：用户每周收到个性化"上周你说了什么"推送；角色能记住用户提到的人。

---

### 12 个月：深化理解、向顾问升级

**主线**：决策助手 + 可选多模态 + 可视化

| 任务 | 理由 |
|------|------|
| goals_plans 分类 + 目标追踪 + 进度报告 | 用 6 个月数据积累后，目标追踪才有足够材料 |
| 决策助手（基于历史偏好/目标/反思给建议）| 需要 preferences + goals_plans 数据积累 |
| 关系曲线 / 情绪曲线 dashboard | polish 层，配合前面的数据丰富化 |
| 多模态摄入（语音 / 图片）MVP | 如果前面方向验证了用户价值，此时才值得大投入 |

**里程碑**：从"陪伴者"升级为"了解我、能给我建议的长期伙伴"。

---

### 一句话总结

**记忆分类是钥匙**——它解锁了后续 7 个方向中至少 5 个的能力前提；成本低（S 级改动）、价值高（乘数效应）、现在就能做。建议下一轮从这里开始。

---

*文档基于 2026-04-28 代码快照。真实数据量极小（DB 共 9 条 memory_items），随用户数增长分类分布会变化，建议每季度回顾排名公式权重。*
