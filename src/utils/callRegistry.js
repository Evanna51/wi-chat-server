/**
 * callRegistry — 在飞 outbound 调用的全局注册表（LLM + 任意 HTTP）。
 *
 * 三个能力：
 *   1. **显式取消**：admin / 业务方拿 callId 主动 cancel
 *   2. **supersede 取消**：register() 时同 kind+scopeKey 的旧调用被自动 abort
 *      （用于"新一轮覆盖旧的"语义，如 chat_reply / catchup / proactive_plan）
 *   3. **可观察**：list() 拿当前在飞调用，admin UI / 监控用
 *
 * 不做 watchdog —— 总时长 / 闲置阈值用 per-call timeout 解决（registeredFetch 的 timeoutMs）。
 *
 * Singleton：require 即拿到全局实例。CallRegistry class 也导出供测试单独 new。
 */

const { v7: uuidv7 } = require("uuid");

// Per-kind 默认行为。call site 可通过 opts.supersede 显式覆盖。
//
// supersede=true：register() 时同 kind+scopeKey 的旧调用立即 abort。用于
// "新一轮自动覆盖旧的"场景：用户连发消息时旧 chat_reply 没用了，新一轮 catchup
// 进来时旧的没必要继续等等。
const KIND_DEFAULTS = Object.freeze({
  // user-facing，强烈 supersede（旧的没意义了）
  chat_reply:      { supersede: true },
  catchup:         { supersede: true },
  proactive_plan:  { supersede: true },

  // cron / 后台任务，并行无害
  reflect:         { supersede: false },
  episode_build:   { supersede: false },

  // 短任务，多并发常态
  memory_classify: { supersede: false },
  memory_decide:   { supersede: false },
  embed:           { supersede: false },
  vector_query:    { supersede: false },

  // 通用兜底（registeredFetch kind="http" 默认走这条）
  http:            { supersede: false },
});

class CallRegistry {
  constructor() {
    this.calls = new Map();
  }

  /**
   * Register a new in-flight call.
   *
   * @param {object}   opts
   * @param {string}   [opts.kind="http"]   分类（决定默认 supersede 行为）
   * @param {string?}  [opts.scopeKey]      scope（如 assistantId）；null = 不参与 supersede
   * @param {string?}  [opts.summary]       人类可读 debug 描述（admin UI 显示）
   * @param {boolean?} [opts.supersede]     显式开关；undefined 时按 KIND_DEFAULTS
   * @returns {{ callId: string, signal: AbortSignal }}
   */
  register({ kind = "http", scopeKey = null, summary = "", supersede } = {}) {
    const effectiveSupersede = supersede ?? KIND_DEFAULTS[kind]?.supersede ?? false;
    if (effectiveSupersede && scopeKey != null) {
      this._cancelByScope(kind, scopeKey, "superseded");
    }
    const callId = uuidv7();
    const abortController = new AbortController();
    this.calls.set(callId, {
      abortController,
      kind,
      scopeKey,
      summary,
      startedAt: Date.now(),
    });
    return { callId, signal: abortController.signal };
  }

  /** 调用结束（成功 / 失败 / abort）后清理。**必须**在 finally 里调。 */
  unregister(callId) {
    this.calls.delete(callId);
  }

  /**
   * 显式取消。已结束的 callId 返回 false（safe to spam）。
   * @returns {boolean} true if found and aborted
   */
  cancel(callId, reason = "manual") {
    const c = this.calls.get(callId);
    if (!c) return false;
    try { c.abortController.abort(new Error(reason)); } catch (_e) { /* ignore */ }
    this.calls.delete(callId);
    return true;
  }

  /** 按 kind+scopeKey 批量取消。返回取消的数量。 */
  cancelByScope(kind, scopeKey, reason = "manual_scope") {
    return this._cancelByScope(kind, scopeKey, reason);
  }

  _cancelByScope(kind, scopeKey, reason) {
    let count = 0;
    for (const [id, c] of this.calls) {
      if (c.kind === kind && c.scopeKey === scopeKey) {
        try { c.abortController.abort(new Error(reason)); } catch (_e) { /* ignore */ }
        this.calls.delete(id);
        count++;
      }
    }
    return count;
  }

  /** 当前在飞调用快照（admin / 监控用）。 */
  list() {
    const now = Date.now();
    return Array.from(this.calls.entries()).map(([id, c]) => ({
      callId: id,
      kind: c.kind,
      scopeKey: c.scopeKey,
      summary: c.summary,
      startedAt: c.startedAt,
      durationMs: now - c.startedAt,
    }));
  }

  /** 测试隔离用 —— 清空所有注册项（不 abort，避免污染 controller）。 */
  _clearForTests() {
    this.calls.clear();
  }
}

const registry = new CallRegistry();

module.exports = registry;
module.exports.CallRegistry = CallRegistry;
module.exports.KIND_DEFAULTS = KIND_DEFAULTS;
