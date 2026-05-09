# archive/ — 已交付 / 已归档的设计与笔记

> 这里的文档**不再代表当前事实状态**。保留是为了：留 review 痕迹 + 给后人理解某个设计选择的来龙去脉。
> 工程上当前应该信任：仓库代码、`docs/architecture.md`、`docs/EXECUTION-PROGRESS.md`、`docs/character-cognition-architecture.md`、`docs/character-system.md`。

---

## 索引

| 文档 | 类型 | 落地于 | 替代位置 |
|------|------|--------|----------|
| [agentic-rag-tool-spec.md](./agentic-rag-tool-spec.md) | tool 设计稿 | commit 7a91669 / `routes/api.js` `/tool/memory-recall` | [docs/ai-tool-memory-recall-and-correct.md](../ai-tool-memory-recall-and-correct.md) |
| [character-state-machine-plan.md](./character-state-machine-plan.md) | 设计稿 | migration 011 + characterStateService + emotionTaxonomy | [docs/character-cognition-architecture.md](../character-cognition-architecture.md) |
| [memory-classification-plan.md](./memory-classification-plan.md) | 设计稿 | migration 013 + memoryClassificationService | [docs/architecture.md §4.2](../architecture.md) |
| [extended-mood-taxonomy.md](./extended-mood-taxonomy.md) | 研究报告（12→170 情绪） | Phase B.2: GoEmotions 27+95=122 词 | [emotionTaxonomy.js](../../src/services/emotionTaxonomy.js) |
| [personal-ai-db-roadmap.md](./personal-ai-db-roadmap.md) | 能力缺口路线图（2026-04-28） | LLM provider 抽象 / 备份 / 角色状态机均已落地；剩余项见 [refactor-plan.md](../refactor-plan.md) | [docs/refactor-plan.md](../refactor-plan.md) |
| [product-direction-analysis.md](./product-direction-analysis.md) | 产品方向分析（2026-04-28） | 角色状态机 + 记忆分类 + agentic RAG 已采纳实现 | [docs/architecture.md](../architecture.md) |
| [realtime-and-autonomous-redesign.md](./realtime-and-autonomous-redesign.md) | 重构方案 | Phase A (catchup) + Phase B (proactive plan) + Phase C (WebSocket) 全部完成 | [docs/architecture.md §9 §12](../architecture.md) |
| [reading-notes.md](./reading-notes.md) | 项目阅读笔记（基于 commit 627fdc1） | 严重过时（FCM / lifeMemory cron 等已删，migration 仅有 10 条版本） | [docs/architecture.md](../architecture.md) |
| [storage-optimization-plan.md](./storage-optimization-plan.md) | 存储瘦身方案 | Phase 1（hygiene + journal rename）+ Phase 2（vector blob）已落地，Phase 3+ 收编进 [refactor-plan.md](../refactor-plan.md) | [docs/refactor-plan.md](../refactor-plan.md) |

---

## 归档原则

- 设计稿对应的代码已合入主干 → 归档
- 路线图覆盖的项已大部分落地 → 归档（残留项移到 refactor-plan）
- 笔记基于过时 commit 且与现状偏差大 → 归档
- 删除阈值：仅当文档**完全没有历史价值**时才删除（迄今没动手删过）
