/**
 * turnEvents.js — ingest 内进程事件总线（T-09）
 *
 * 把 `ingestTurnsBatch` 的副作用（cancel pending plans / 更新 character_state /
 * scheduleNextPushPlan）从调用层（routes/sync.js / ws/server.js）剥离到这里。
 *
 * 解决的问题：
 *   - sync.push / sync.snapshot / ws.message_create 三处重复实现同一组副作用
 *   - 加任何新副作用（监控 / 日志 / 第三方推送）都要改 N 个调用点
 *
 * 不变量：
 *   - emit **必须**在 ingest 事务 commit 之后调（better-sqlite3 同步事务，函数返回即提交）
 *   - 监听器不抛错（每个监听器自己 try/catch + log），失败不影响其它监听器或 emit 调用方
 *   - 监听器若有耗时操作（LLM、网络），自行 setImmediate 异步化，不要在 emit 路径上阻塞
 *
 * 事件类型：
 *   - 'turn.user.batch'   一批 user-role turn 已落库（含 perAssistant stats）
 *
 * 不需要分到这里的：
 *   - assistant role 落库 —— 客户端权威，server 不基于 AI 回复触发任何下游
 *   - tool_call/tool_result/system role —— 日志型，没有下游
 */

const EventEmitter = require("events");

class TurnEventBus extends EventEmitter {
  /**
   * 一批 user-role turn 已落库。subscribers 自行决定哪些 assistant 关心、做什么。
   *
   * @param {object} payload
   * @param {string} payload.assistantId
   * @param {string|null} payload.userId        — 调用方传入的 userId（可能 null）
   * @param {string} payload.cause              — 'sync.push' | 'sync.snapshot' | 'ws.message_create'
   * @param {object} payload.stats
   * @param {number} payload.stats.userTurnCount
   * @param {number} payload.stats.lastUserAt
   * @param {string|null} payload.stats.lastUserContent
   */
  emitUserBatch(payload) {
    if (!payload?.assistantId) return;
    try {
      this.emit("turn.user.batch", payload);
    } catch (err) {
      // EventEmitter 默认会重新抛 listener 的 sync 异常；理论上 listener 都 try/catch 了
      console.error("[turnEvents] unexpected emit failure:", err.message);
    }
  }
}

const turnEvents = new TurnEventBus();
turnEvents.setMaxListeners(20); // 默认 10 不够；3 内置 + 余量

module.exports = { turnEvents };
