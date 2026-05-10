/**
 * schedulerLock — DB-based 短 TTL leader lock，给 cron tick 用。
 *
 * 解决：多 instance 同时触发 cron（PM2 restart 双进程 / dev 启副本）→ 重复跑。
 *
 * 实现：scheduler_lock 表（migration 033）+ atomic INSERT OR REPLACE WHERE expires_at < now。
 * SQLite 在事务里执行 atomic，保证只有一个进程能 acquire。
 *
 * TTL 用法：每个 cron tick 抢锁时设 ttl > 预计 tick 执行时间（带余量）。
 * holder 崩溃不释放也没关系 — 下次 cron 触发时 ttl 已过期，新 holder 能 acquire。
 *
 * holder_id 用 process.pid + boot_at + label 拼出来，不依赖外部协调。
 */

const { db } = require("../db");
const config = require("../config");

const BOOT_AT = Date.now();

function makeHolderId(label) {
  return `${config.schedulerLeaderId || "host"}:${process.pid}:${BOOT_AT}:${label}`;
}

/**
 * 尝试抢锁。已有锁且未过期 → false；已有锁但过期 → 抢占成功 true；空 → 占有 true。
 *
 * @param {string} lockName       全局唯一锁名（如 "plan_generation_tick"）
 * @param {number} ttlMs          ttl，必须 > 预计 tick 执行时间（带余量）
 * @param {string} [labelHint]    用于 holder_id 显示，便于诊断（默认 lockName）
 * @returns {boolean}             抢到了返回 true，没抢到 false
 */
function tryAcquireLock(lockName, ttlMs, labelHint) {
  if (!lockName || !ttlMs) {
    throw new Error("schedulerLock.tryAcquireLock: lockName + ttlMs required");
  }
  const now = Date.now();
  const holderId = makeHolderId(labelHint || lockName);
  const expiresAt = now + ttlMs;

  // 单事务内：删过期 + try insert。SQLite atomic。
  const tx = db.transaction(() => {
    // 删本 lock_name 的过期 row（如有）
    db.prepare(
      "DELETE FROM scheduler_lock WHERE lock_name = ? AND expires_at < ?"
    ).run(lockName, now);
    // try insert 新行；如果已存在（其它 holder 抢到了），insert 失败 → 我们没抢到
    try {
      db.prepare(
        "INSERT INTO scheduler_lock (lock_name, holder_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)"
      ).run(lockName, holderId, now, expiresAt);
      return true;
    } catch (e) {
      // SQLITE_CONSTRAINT_PRIMARYKEY → 没抢到
      if (e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || /UNIQUE constraint/.test(e.message)) {
        return false;
      }
      throw e;
    }
  });

  return tx();
}

/**
 * 释放锁。仅当 holder_id 匹配时才删除（防误释放他人锁）。tick 跑完后调用。
 *
 * 不抛错 —— 释放失败不影响主流程。
 */
function releaseLock(lockName, labelHint) {
  if (!lockName) return;
  const holderId = makeHolderId(labelHint || lockName);
  try {
    db.prepare(
      "DELETE FROM scheduler_lock WHERE lock_name = ? AND holder_id = ?"
    ).run(lockName, holderId);
  } catch (_) { /* swallow */ }
}

/**
 * 高阶 wrapper：用 lock 包住 fn。抢不到锁直接 skip 返回 null，否则跑 fn 后释放锁。
 *
 * @param {string} lockName
 * @param {number} ttlMs
 * @param {function} fn         async function 跑 cron tick 的实际工作
 * @returns {Promise<{ skipped: true } | { skipped: false, result }>}
 */
async function withLock(lockName, ttlMs, fn) {
  if (!tryAcquireLock(lockName, ttlMs, lockName)) {
    return { skipped: true, reason: "lock_held_by_other" };
  }
  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    releaseLock(lockName, lockName);
  }
}

module.exports = {
  tryAcquireLock,
  releaseLock,
  withLock,
};
