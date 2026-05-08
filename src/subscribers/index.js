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

const SUBSCRIBERS = [
  require("./cancelPendingPlans"),
  require("./scheduleNextPush"),
  require("./characterStateUpdater"),
];

function registerAll() {
  for (const sub of SUBSCRIBERS) {
    sub.register(turnEvents);
  }
}

module.exports = { registerAll, turnEvents };
