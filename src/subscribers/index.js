/**
 * 注册所有 turn 事件订阅者。
 *
 * 在 src/index.js 启动早期 require 一次即可（必须在 routes / ws 接收第一条 turn 之前）。
 *
 * 加新 subscriber 步骤：
 *   1. 写一个 module 导出 `register(turnEvents)` 函数
 *   2. 在下面 SUBSCRIBERS 列表加进去
 *   3. 重启服务
 *
 * 删 subscriber：从列表删一行 + 删文件，不需要改任何调用方。
 */
const { turnEvents } = require("../events/turnEvents");

// turn-event subscribers — register(turnEvents)
const TURN_SUBSCRIBERS = [
  require("./cancelPendingPlans"),
  require("./scheduleNextPush"),
  require("./characterStateUpdater"),
];

// 自管理 subscribers（监听 profileEvents 等其它 event bus，自己 import）
// 这些 register() 不需要参数。
const STANDALONE_SUBSCRIBERS = [
  require("./personaExtraction"),
];

function registerAll() {
  for (const sub of TURN_SUBSCRIBERS) {
    sub.register(turnEvents);
  }
  for (const sub of STANDALONE_SUBSCRIBERS) {
    sub.register();
  }
}

module.exports = { registerAll, turnEvents };
