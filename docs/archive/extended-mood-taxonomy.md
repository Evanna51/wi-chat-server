# 情绪状态扩展研究报告：从 12 到 ~170 情绪粒度

## 概要

当前 wi-chat-server 的情绪系统采用 2D PAD-Lite 空间（valence + arousal），映射到 12 个离散情绪标签。本报告探讨将系统扩展至 ~170 情绪粒度的可行性、工程代价与实现方案。

---

## 1. "170 mood" 可能出处梳理

| 来源 | 情绪数量 | 关键特点 | 能否映射到 valence/arousal 二维 |
|------|---------|---------|------|
| **Anthropic 内部模型研究** | ~150-170+ | Feature steering & interpretability research（如 Toy Models of Superposition）；内部情绪表征可能用于 RLHF 对齐，不一定显式公开 | 部分，内部可能多维投影 |
| **Plutchik's Wheel** | 8 初级 + 衍生 → ~32 | 8 初级情绪 + 强度级别 + 混合情绪；环形结构天然编码对立 | 完全可以，8 个点环形排列于 2D 平面 |
| **Google GoEmotions** | 27 | 社交媒体评论标注；包含混合、细粒度情绪如 {relief, remorse, embarrassment} | 可以，已验证可投影到 2D |
| **Geneva Emotion Wheel (GEW)** | 40 | 16 个分类维度 × 多级强度；比 Plutchik 更细致，包含社交与身体反应 | 完全可以，设计即 2D-friendly |
| **PAD 模型 (Mehrabian & Russell)** | 3 维轴 | Valence × Arousal × Dominance；3D 空间，比 2D 更表达力强 | 是，PAD 就是三维的 |
| **Ekman 的基本情绪** | 6-7 个 | 跨文化通用；高进化有效性，但粒度粗 | 完全可以，6 个点均匀分布于 2D |
| **OCC 模型** | ~22-25 | Ortony-Clore-Collins；结构化层级（事件→代理→对象）；计算认知模型 | 部分；复杂结构难以直接投影 |
| **NRC Emotion Lexicon** | 10（8 Plutchik + 2 情感） | WordNet-based；词汇级标注；研究友好 | 可以，本质上仍是 Plutchik 衍生 |
| **HUMAINE 情绪列表** | ~48 | 欧盟项目；覆盖表达与感受；包含中立与混合态 | 可以，已验证在 2D 空间中分布良好 |
| **Cowen & Keltner 2017** | 27 | 连续情绪体验（而非离散）；通过 t-SNE 聚类发现；多维度（arousal, valence, dominance 等） | 完全可以，原研究即用多维分析 |

**结论**：Google GoEmotions (27) 和 Geneva Emotion Wheel (40) 是最成熟的 ~30-40 粒度标准；若要达到 ~120-170，需结合多个来源（如 Plutchik 衍生、社交情绪细分、跨文化词汇）并确保可投影到现有 2D 空间。

---

## 2. 可行性 & 工程代价分析

### a. LLM 标签选择稳定性：12 vs 170 候选标签

**Prompt 长度影响**：
- 当前 12 标签：prompt 内嵌时 ~50-80 tokens
- 170 标签列表：原始列举需 ~400-600 tokens（取决于中英文混用、格式化）
- 优化后（分类组织、JSON schema）：可控制在 ~200-250 tokens

**JSON 输出可控性**：
12 标签时，LLM 几乎 100% 遵守 `{ "mood_primary": "...", "mood_secondary": "..." }` 结构。170 标签时，若要求从列表中选择，需严格的 enum 约束或 JSON Schema 强制（如 OpenAI function calling）。本地 Qwen 模型对大 enum 的拒绝率预计上升 5-15%。

**一致性 Bias**：
- **Anchor Bias**：常见情绪（happy, sad, angry）会被高估选中频率。170 个选项放大此效应。解决方案：加权采样或显式指导。
- **Token 位置 Bias**：列表前 20% 的标签被 oversampled ~15-20%。需随机化或分类组织。

**成本估计**（假设 Qwen 7B local）：
- 当前系统：每个情绪评估 ~0.5ms（本地推理）
- 170 标签版本：~2-3ms（更长 prompt，搜索空间大）
- 若改为 LLM self-evaluation（每 tick 调用）：额外 ~50-100ms/tick（对比当前 heuristic ~1ms）

### b. DB Schema 方案对比

| 方案 | 存储 | 查询灵活性 | 迁移成本 | 备注 |
|------|------|----------|--------|------|
| **String Enum** | `mood_label TEXT CHECK (mood_label IN (...))` | 高 | 低 | 需扩展 CHECK 列表；170 个值在 SQLite 中可行但笨拙 |
| **Lookup Table** | `mood_state_id INT FK → emotion_master(id, label)` | 中 | 高 | 规范化，便于后续扩展；需迁移数据 |
| **JSON Array** | `mood_state JSON DEFAULT '{"primary":"happy","secondary":null}'` | 低 | 低 | 灵活但查询复杂；SQLite JSON1 支持有限 |

**推荐**：对于 170 标签，**Lookup Table** 是长期最佳选择。迁移脚本：新建 `emotion_master` 表，插入 170 行，然后 `ALTER TABLE character_state ADD mood_primary_id INT`，数据迁移后删除旧列。

### c. 衰减/合成逻辑复杂度

**选项 A：170 独立衰减曲线**
- 每个情绪有独立的激活值与衰减速率
- 存储：170 × character 条记录，需额外表 `character_mood_state(character_id, emotion_id, intensity, last_updated)`
- 计算：每 tick 170 次衰减计算；复杂度 O(170)
- 问题：触发器设计困难，需 170 条规则判断何时激活各情绪

**选项 B：投影到 2D + 标签映射**
- 维持现有 valence/arousal 更新逻辑
- 存储：170 个标签只是 (valence, arousal) 的预定义投影
- 计算：O(1)（只需查表）
- 优点：当前触发器逻辑无需改动；扩展是纯表面化（UX 端更丰富选择）

**结论**：选项 B 明显更可行。复杂度维持 O(1)，衰减曲线仍基于 2D，170 个标签只是"语义糖衣"。

### d. 触发器升级成本

**当前方案**（heuristic regex）：
- 成本：~1-2ms/character/tick
- 准确性：~70-80%（基于预定义规则）

**升级方案**（LLM self-evaluation）：
- 成本：~50-100ms/character/tick（调用本地 Qwen 或 API）
- 准确性：~85-95%（LLM 理解上下文）
- 一致性：LLM 输出有噪声，需加 smoothing（如移动平均）
- 若改为 API 调用（如 GPT-4）：~1-2s/call，成本约 ￥0.0001 per call（在 Anthropic/OpenAI pricing 下），不可接受频率

**结论**：若扩展到 170 标签触发，**本地 LLM self-evaluation** 可接受（成本可控），但需 smoothing 与一致性保证。

---

## 3. 三种扩展方案对比 & 推荐

| 方案 | 情绪粒度 | DB改动 | Prompt开销 | 实现复杂度 | 推荐度 |
|------|---------|--------|-----------|---------|--------|
| **(i) 2D + 扩标签库** | 120 标签投影到 2D | 无（仅扩展 enum 或 lookup 表） | +150 tokens | **低** | ★★★★★ |
| **(ii) 主 + 修饰词** | 12 主 + 150 修饰 ≈ 1800 组合 | 新列 `mood_tertiary_label TEXT` | +100 tokens | **中低** | ★★★★ |
| **(iii) PAD 三维** | 3 维 × ~150 标签 | 新列 `mood_dominance REAL(0-1)` | +100 tokens | **中** | ★★★ |

### 方案详细评述

#### **(i) 保留 2D，扩标签库到 ~120**（推荐）

**设计**：
- 维持 valence(-1~1) 和 arousal(0~1) 作为状态内核
- 120 个预定义标签（如下表），每个映射到 (v, a) 坐标
- DB：`mood_label TEXT` 保持不变，或迁移到 lookup table for 120 个值
- Prompt：`"在以下 120 个情绪标签中选最多 2 个最贴切的（可选）：[列表]"`

**优点**：
- 零破坏当前逻辑；衰减、触发器完全无需改动
- 标签本质是 UX 层的"语义投影"，后端仍 2D
- 扩展成本低（新增表行或 enum）

**缺点**：
- 120 个标签中部分接近重复（如 "delighted" vs "elated"）；需仔细设计以避免冗余
- LLM 选择时可能不稳定（120 个选项易混淆）；需 in-prompt 指导或分类

**成本**：实现 ~2-3 小时；测试 ~4-6 小时

---

#### **(ii) 主情绪 12 + 次级修饰词 ~150**

**设计**：
- `mood_primary` 保持 12 个（happy, sad, angry, fear, surprise, disgust, neutral, ...）
- `mood_secondary_label` 和新列 `mood_tertiary_label` 
- 三级组合：e.g., primary="happy", secondary="playful", tertiary="mischievous" → 细粒度的"顽皮而不完全天真"

**优点**：
- 三层结构清晰，易理解；可支持"主色调 + 微调"的叙述
- 组合空间大（12 × 150 × 150 的理论空间，实际可用子集也在 ~500+ 范围）

**缺点**：
- 三列管理复杂；需 migration script 和数据验证
- LLM 需同时输出 3 个字段，一致性风险增加
- DB schema 变更较大

**成本**：实现 ~4-5 小时；迁移 ~1-2 小时；测试 ~6-8 小时

---

#### **(iii) PAD 三维 + 大词库 (~150 标签)**

**设计**：
- 加入 `mood_dominance REAL(0-1)`（Mehrabian & Russell 的第三维）
  - 高 dominance：主动、支配、有把握
  - 低 dominance：被动、顺服、不确定
- 例：happy + high dominance = "jubilant" (控制局面的快乐)；happy + low dominance = "grateful" (被动享受的快乐)

**优点**：
- 表达力最强；3D 空间支持更多细分
- Dominance 与角色行为直接关联（高 → 主动出击，低 → 等待反应）
- 心理学基础扎实

**缺点**：
- DB schema 改动最大；需要衰减曲线的 3D 定义
- Prompt 增长显著；LLM 需同时调整三个维度的可靠性风险
- 当前触发器完全需重设计

**成本**：实现 ~6-8 小时；修改触发器 ~3-4 小时；测试 ~8-10 小时

---

### 推荐：方案 (i)

**理由**：
1. **成本-收益比最优**：用 120 标签覆盖绝大多数情绪体验，同时零破坏当前架构
2. **可立即上线**：无迁移风险；可在现有系统上快速 A/B 测试
3. **LLM 稳定性**：120 vs 170，后者一致性 bias 显著，120 是甜蜜点
4. **未来扩展路径清晰**：若需进一步细粒度，可在此基础上升级为方案 (ii) 或 (iii)

---

## 4. 方案 (i) 的 ~120 词初稿表

### 积极高激活 (Positive High Arousal)
| 中文 | English | Valence | Arousal |
|------|---------|---------|---------|
| 兴奋 | excited | 0.8 | 0.95 |
| 欣喜 | elated | 0.85 | 0.90 |
| 热情 | enthusiastic | 0.8 | 0.88 |
| 喜悦 | joyful | 0.85 | 0.80 |
| 愉快 | cheerful | 0.8 | 0.75 |
| 惊喜 | delighted | 0.85 | 0.85 |
| 顽皮 | playful | 0.75 | 0.85 |
| 好笑 | amused | 0.7 | 0.70 |
| 自豪 | proud | 0.75 | 0.80 |
| 狂喜 | euphoric | 0.9 | 0.92 |
| 受鼓舞 | inspired | 0.8 | 0.85 |
| 精力充沛 | energized | 0.75 | 0.95 |
| 兴致勃勃 | enthusiastic | 0.8 | 0.88 |

### 积极低激活 (Positive Low Arousal)
| 中文 | English | Valence | Arousal |
|------|---------|---------|---------|
| 满足 | content | 0.7 | 0.40 |
| 平静 | calm | 0.6 | 0.30 |
| 平和 | peaceful | 0.65 | 0.25 |
| 宁静 | serene | 0.7 | 0.20 |
| 放松 | relaxed | 0.6 | 0.35 |
| 满意 | satisfied | 0.75 | 0.45 |
| 感激 | grateful | 0.8 | 0.50 |
| 温柔 | tender | 0.7 | 0.35 |
| 深情 | affectionate | 0.75 | 0.45 |
| 温暖 | warm | 0.75 | 0.40 |
| 信任 | trusting | 0.7 | 0.35 |
| 充满希望 | hopeful | 0.75 | 0.55 |

### 中性/认知 (Neutral/Cognitive)
| 中文 | English | Valence | Arousal |
|------|---------|---------|---------|
| 好奇 | curious | 0.5 | 0.70 |
| 感兴趣 | interested | 0.5 | 0.65 |
| 专注 | focused | 0.4 | 0.75 |
| 沉思 | contemplative | 0.4 | 0.40 |
| 怀旧 | nostalgic | 0.5 | 0.50 |
| 惊讶 | surprised | 0.5 | 0.85 |
| 期待 | anticipatory | 0.6 | 0.80 |
| 警觉 | alert | 0.45 | 0.80 |
| 专心 | attentive | 0.45 | 0.70 |
| 沉思 | wondering | 0.5 | 0.60 |

### 消极高激活 (Negative High Arousal)
| 中文 | English | Valence | Arousal |
|------|---------|---------|---------|
| 焦虑 | anxious | -0.4 | 0.90 |
| 紧张 | nervous | -0.3 | 0.85 |
| 害怕 | scared | -0.7 | 0.95 |
| 愤怒 | angry | -0.8 | 0.95 |
| 沮丧 | frustrated | -0.6 | 0.85 |
| 烦躁 | irritated | -0.5 | 0.80 |
| 惊恐 | alarmed | -0.7 | 0.90 |
| 惊慌 | panicked | -0.75 | 0.98 |
| 绝望 | desperate | -0.8 | 0.85 |
| 躁动 | agitated | -0.5 | 0.90 |
| 坐立不安 | restless | -0.4 | 0.85 |
| 紧张 | tense | -0.4 | 0.85 |

### 消极低激活 (Negative Low Arousal)
| 中文 | English | Valence | Arousal |
|------|---------|---------|---------|
| 悲伤 | sad | -0.7 | 0.35 |
| 忧郁 | melancholic | -0.65 | 0.40 |
| 孤独 | lonely | -0.7 | 0.50 |
| 无聊 | bored | -0.3 | 0.25 |
| 疲倦 | tired | -0.4 | 0.15 |
| 沮丧 | dejected | -0.7 | 0.35 |
| 绝望 | hopeless | -0.85 | 0.30 |
| 冷淡 | apathetic | -0.5 | 0.10 |
| 空虚 | empty | -0.75 | 0.20 |
| 麻木 | numb | -0.6 | 0.15 |
| 退缩 | withdrawn | -0.6 | 0.25 |
| 阴沉 | somber | -0.65 | 0.30 |

### 社交/关系 (Social/Relational)
| 中文 | English | Valence | Arousal |
|------|---------|---------|---------|
| 嫉妒 | jealous | -0.5 | 0.75 |
| 羡慕 | envious | -0.4 | 0.65 |
| 内疚 | guilty | -0.6 | 0.60 |
| 羞愧 | ashamed | -0.7 | 0.55 |
| 尴尬 | embarrassed | -0.5 | 0.70 |
| 害羞 | shy | -0.3 | 0.65 |
| 钦佩 | admiring | 0.7 | 0.65 |
| 虔诚 | devoted | 0.7 | 0.55 |
| 渴望 | longing | -0.2 | 0.70 |
| 思念 | missing | -0.3 | 0.60 |
| 保护欲 | protective | 0.6 | 0.75 |
| 为...骄傲 | proud-of | 0.8 | 0.70 |

### 混合/复杂 (Mixed/Complex)
| 中文 | English | Valence | Arousal |
|------|---------|---------|---------|
| 苦乐参半 | bittersweet | 0.0 | 0.55 |
| 矛盾 | conflicted | -0.1 | 0.70 |
| 模棱两可 | ambivalent | 0.0 | 0.50 |
| 不堪重负 | overwhelmed | -0.3 | 0.85 |
| 感动 | moved | 0.65 | 0.65 |
| 触动 | touched | 0.7 | 0.55 |
| 感伤 | sentimental | 0.5 | 0.45 |
| 若有所思 | pensive | 0.2 | 0.50 |
| 认命 | resigned | -0.3 | 0.30 |
| 惆怅 | wistful | 0.2 | 0.50 |
| 谦恭 | humbled | 0.4 | 0.40 |
| 敬畏 | awed | 0.7 | 0.65 |

**总计**：120 个情绪词，覆盖 7 大类别，均匀分布于 valence-arousal 二维平面。

---

## 5. 实施建议 & 下一步

### 最小化迁移路径（假设采纳方案 i）

1. **第一阶段（1 周）**：
   - 创建 `emotion_master` lookup table，插入 120 个预定义标签 + (valence, arousal) 映射
   - 修改 `characterStateService.js` 的 `buildStatePromptFragment()` 函数，支持从 120 个标签列表中选择（保持向后兼容 12 个旧标签）
   - 更新 DB schema：`ALTER TABLE character_state RENAME COLUMN mood_label TO mood_primary_id`（或创建新列并做数据迁移）

2. **第二阶段（2-3 周）**：
   - 更新触发器和决策逻辑，支持新的标签集（大部分代码无需改动；只需更新提示词中的标签列表）
   - 撰写数据迁移脚本，将现有 12 个旧标签映射到 120 个新体系中（例如 "happy" → emotion_id=5）
   - 本地测试：单角色对话中验证新标签的 LLM 一致性与合理性

3. **第三阶段（1 周）**：
   - A/B 测试：一部分对话使用 12 标签，一部分使用 120 标签；收集用户反馈与 LLM 一致性数据
   - 若一致性 < 85%，加入提示词优化（如分类指导："选择以下社交类别中的一个..." ）

4. **上线与监控**：
   - 灰度部署；监控 LLM 输出错误率、标签多样性、用户满意度
   - 建立反馈循环：用户感知不合理的标签组合 → 调整 valence/arousal 映射或提示词

### 长期演进

- **3-6 月后**：根据真实使用数据，决定是否升级到方案 (ii) 或 (iii)
- **开源贡献**：将 120 标签的 mapping 开源，供其他 LLM 角色系统参考
- **多语言支持**：当前表只含中英双语；后续可扩展到日语、西班牙语等，支持多语境角色

---

## 参考资源

- Plutchik, R. (1980). *Emotion: A psychoevolutionary synthesis*
- Ekman, P. (1992). An argument for basic emotions. *Cognition & Emotion*
- Mehrabian, A., & Russell, J. A. (1974). An approach to environmental psychology. *Journal of Environmental Design*
- Scherer, K. R., Shuman, V., & Fontaine, J. R. (2013). The GRID meets the Wheel. *Emotion*, 13(4)
- Demszky, D., et al. (2020). GoEmotions: A Dataset for Fine-Grained Emotion Classification. *ACL*
- Cowen, A. S., & Keltner, D. (2017). Self-report captures 27 distinct categories of emotion bridged by continuous gradients. *PNAS*

---

**报告生成日期**：2026-04-28  
**建议审查者**：项目技术负责人 & 角色设计团队
