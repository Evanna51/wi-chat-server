# 检索回归 fixture

> 给 `memoryRetrievalService.retrieveMemory` 建立 baseline。
> 改任何评分权重 / 半衰期 / source filter 时跑一遍，看分数是否退化。

## 设计原则

1. **隔离命名空间**：所有 fixture 用 `assistant_id` 前缀 `eval-fix-` 开头，与生产数据隔离。
2. **种子可重复**：每个 fixture 自带种子 turns，eval harness 启动时 wipe 该 fixture 命名空间下所有数据再重建，**不污染**生产 conversation_turns。
3. **稳定 ground truth**：matchHints 用关键词组合（必须**全部**出现在 memory.content 子串里）；不依赖 memory_item id 因为 id 每次重建都不同。
4. **覆盖三大场景**：
   - SQL-first（带时间窗）：测时间过滤
   - vector-first（开放查询）：测语义召回 + recency 衰减
   - 边缘 case：知识库过滤 / pin 显式 / echo 排除

## fixture 文件格式（JSON）

```json
{
  "name": "01-preference-coffee-recall",
  "description": "用户多次提到喜欢拿铁，相关 query 应在 top-1 召回",

  "assistantId": "eval-fix-01",          // 必填，命名空间隔离用
  "sessionId": "eval-fix-01-sess",       // 必填

  "seed": [                               // 种子 turns，按 createdAtOffsetMs 排序写入
    {
      "role": "user",
      "content": "我最近爱喝拿铁，每天早上都要一杯",
      "createdAtOffsetMs": -86400000     // 相对于 eval 启动时刻的毫秒偏移
    },
    {
      "role": "assistant",
      "content": "听起来你很享受这种早晨仪式感",
      "createdAtOffsetMs": -86399000
    },
    {
      "role": "user",
      "content": "今天天气不错",
      "createdAtOffsetMs": -3600000
    }
  ],

  "query": "我最爱的咖啡是什么？",        // 检索 query
  "topK": 5,                              // 默认 5
  "retrievalOptions": {                   // 透传给 retrieveMemory（可选）
    "source": "user",
    "withinDays": 30
  },

  "expected": {
    "topKContains": [                     // 必须全部满足
      {
        "matchHints": ["拿铁"],            // 命中规则：content 必须包含**所有**这些子串
        "minRank": 1,                     // 必须排在前 N 位（含），1 = 必须 top-1
        "maxRank": 5                      // 必须出现在前 N 位（含），N 默认等于 topK
      }
    ],
    "topKExcludes": [                     // 不应出现的 hint 组合
      { "matchHints": ["天气"] }          // 闲聊不该挤进相关检索
    ],
    "minRecallAt5": 1.0,                  // 整体阈值（可选）
    "minMrr": 1.0
  }
}
```

## 评分指标

eval harness 输出每个 fixture：
- `pass / fail`：所有 `topKContains.minRank` 满足且 `topKExcludes` 不出现
- `recall@5`：命中数 / 期望数
- `mrr`：第一条期望命中的 1/rank
- `latencyMs`

汇总：
- 总通过率 / 平均 recall@5 / 平均 MRR
- 与上次 baseline 比对（diff）—— 跑两次自动写 baseline，第三次起对比

## 重要约定

- fixture 命名 `NN-shortname.json`，编号从 01 开始
- assistant_id 形如 `eval-fix-NN`（与文件编号一致）
- seed[] 必须**按 offset 升序**（旧到新）
- 时间偏移使用负值（过去）；正值会被 ingest 拒绝（clock correction）
- 单 fixture seed 不超过 30 条（保持启动开销可控）

## 跑 eval

```bash
# 全跑
npm run eval:retrieval

# 只跑某一个
npm run eval:retrieval -- --only 01-preference-coffee-recall

# 写 baseline（首次或主动覆盖）
npm run eval:retrieval -- --write-baseline

# 跟 baseline 对比，超过 5% 退化退出码非 0（用于 CI）
npm run eval:retrieval -- --compare-baseline --regression-threshold 0.05
```

## 何时新增 fixture

- 新发现的 retrieval bug → 复现成 fixture（regression test）
- 新加 retrieval 维度（如知识库） → 加专项 fixture
- 不要为「想到啥写啥」加 fixture，否则维护成本爆炸

每个 fixture 必须答得出："如果我退化了，我能保住什么？"
