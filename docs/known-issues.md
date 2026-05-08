# 已知可优化项（不计划立刻修）

> 这里记录的问题**已知存在、不影响内网当前使用**、有清晰的修复路径，但优先级排在 [refactor-plan.md](./refactor-plan.md) 之后。
> 触发条件 / 修复成本一并记录，避免下次有人重新 review 时再发现一次。

---

## KI-01 鉴权裸奔（仅内网）

**现状**：
- 全局共享一个 `APP_API_KEY`（[config.js:93](../src/config.js#L93)），无 per-user / per-tenant 隔离。
- `REQUIRE_API_KEY` 默认 `0`，开发环境完全不验。
- WS 走 `ws://host/api/ws?apiKey=&userId=` query 参数：
  - `apiKey` 出现在 URL → 反代日志、Referer、浏览器 history 全泄露。
  - `userId` 是请求方自己声明 → 拿到 API key 等同拿到所有 user 的会话权限。

**触发条件**：
- 服务上公网 / 多租户 / 多客户。
- API key 通过日志/截图泄露。

**修复方向**：
1. WS 鉴权改为首帧 `auth` 消息（payload 含 token），URL 不带任何凭证。
2. token per-user 签发（短 TTL JWT 或 opaque token + redis），server 从 token 解析 userId，不再信任 query。
3. `REQUIRE_API_KEY=1` 在生产强制；引入 per-user rate limit（按 userId 计数器）。
4. `provider_call_log` 加 cost / token 聚合，按 user 出账。

**预估成本**：3-5 天（含客户端联调）。

---

## KI-02 character_state 写回 TOCTOU（对应 T-16）

**现状**：
- 所有读 `character_state` 都过 `getEffectiveState`（[characterStateService.js:185](../src/services/characterStateService.js#L185)）现算衰减。
- 写入逻辑（`onUserMessage` / `applyMoodEvent`）：先读 effective → 计算 delta → 写回。
- 中间无版本号 / 锁，理论上两个并发请求可丢更新。

**实际影响**：
- SQLite 单写本身串行化语句级写，丢更新只发生在「读 → 计算 → 写」跨语句的应用层窗口。
- 当前业务场景下：
  - WS message_create 串行处理（同一连接），同一 user 的写不会并发
  - sync/push 是批处理整事务
  - cron 不写 character_state
- 实测**未观察到**丢更新。

**触发条件**：
- 同一 user 同时建立多个 WS 连接 + 同时来 sync/push（多端同时活跃）
- 未来引入 `applyMoodEvent` 的额外异步路径

**修复方向**：
- 给 `character_state` 加 `version INTEGER NOT NULL DEFAULT 0` 列
- 写回改 CAS：`UPDATE ... SET ..., version=version+1 WHERE assistant_id=? AND version=?`
- 失败时重读 effective state 重新计算 delta，最多重试 3 次

**预估成本**：半天（含测试）。

---

## KI-03 LLM 调用无熔断 / 无成本聚合

**现状**：
- 5 处 LLM 调用（classify / plan / decide / catchup / generate）共用一个 OpenAI-compatible client，目标 LM Studio。
- LM Studio 挂掉时各路径有 heuristic fallback，但**没有**集中熔断器：所有路径会持续重试，把 LM Studio 启动后的恢复期淹没在请求中。
- `provider_call_log` 写了入参出参，但没有按 user / 按调用点聚合的统计 view。

**触发条件**：
- LM Studio 重启 / OOM / GPU OOM。
- LLM 模型推理变慢（context 长度增加 / 模型升级）。

**修复方向**：
1. 在 `decisionPipeline`（T-12 已规划）里加熔断：连续失败 N 次 → open 状态 5min，期间所有调用走 heuristic 不走网络。
2. `provider_call_log` 加聚合视图（每日 / 按 service 名分组），导出到 `/admin/llm-stats` 端点或 cron 写 markdown 报告。

**预估成本**：1 天（在 T-12 完成后增量做）。

---

## KI-04 FTS5 trigram 索引膨胀

**现状**：
- `memory_items_fts` 用 `trigram case_sensitive 0`，支持中文子串匹配，索引体积约为原内容 7-8x。
- migration 020 已删 `conversation_turns_fts`，省了大头；剩下的 `memory_items_fts` 是必需的（搜索靠它）。

**触发条件**：
- memory_items 行数 > 1M（粗估单 user 半年内不太可能）。
- 用户对搜索性能敏感（trigram 在 100k+ 行后查询会变慢）。

**修复方向**：
- 评估改 `unicode61 + tokenchars="-_."` 配 jieba 分词预处理（应用层切词写入 fts）。
- 或者上 FTS5 + bm25 + 外部分词模块（`fts5_tokenizer` C 扩展）。

**预估成本**：2 天（含分词器选型 + 召回率回归测试）。

---

## 维护规则

- 只有「**有清晰修复方案 + 当前不修**」的问题进这里。
- 「不知道怎么修」的进 `docs/adr/` 起 ADR；「立刻修」的进 `refactor-plan.md`。
- 任何 KI 项目被实际触发（线上事故 / 业务诉求变更）→ 升级到 refactor-plan 并设优先级。
