const config = require("../config");
const { db } = require("../db");

function isRetryableBusyError(error) {
  const code = String(error?.code || "");
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT";
}

function tryAcquireSchedulerLock(lockName = config.legacyFcmProactiveLockName) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const now = Date.now();
    const leaseUntil = now + config.schedulerLockTtlMs;
    const leaderId = config.schedulerLeaderId;
    const tx = db.transaction(() => {
      const existing = db
        .prepare("SELECT leader_id, lease_until FROM scheduler_locks WHERE lock_name = ?")
        .get(lockName);
      if (!existing || existing.lease_until < now || existing.leader_id === leaderId) {
        db.prepare(
          `INSERT INTO scheduler_locks (lock_name, leader_id, lease_until, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(lock_name) DO UPDATE SET
             leader_id=excluded.leader_id,
             lease_until=excluded.lease_until,
             updated_at=excluded.updated_at`
        ).run(lockName, leaderId, leaseUntil, now);
        return true;
      }
      return false;
    });
    try {
      return tx();
    } catch (error) {
      if (!isRetryableBusyError(error) || attempt >= maxAttempts) throw error;
    }
  }
  return false;
}

module.exports = { tryAcquireSchedulerLock };
