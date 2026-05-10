/**
 * profileEvents.js — assistant_profile 变化的进程内事件总线（Phase 3）。
 *
 * 类似 turnEvents 的设计模式，但作用域是 profile 写入。当前唯一事件：
 *   - 'profile.setup_prompt.changed': 用户写入新 setup_prompt（创建 / 编辑角色），
 *     personaExtraction subscriber 监听后异步跑 LLM 提炼。
 *
 * 不变量：
 *   - emit 必须在 upsertAssistantProfile 事务后调（caller 责任）
 *   - 监听器自己 setImmediate 异步化，不阻塞 emit 调用方
 *   - 监听器自己 try/catch，失败不影响其它监听器
 */

const EventEmitter = require("events");

class ProfileEventBus extends EventEmitter {
  emitSetupPromptChanged(payload) {
    if (!payload?.assistantId) return;
    try {
      this.emit("profile.setup_prompt.changed", payload);
    } catch (err) {
      console.error("[profileEvents] unexpected emit failure:", err.message);
    }
  }
}

const profileEvents = new ProfileEventBus();
profileEvents.setMaxListeners(10);

module.exports = { profileEvents };
