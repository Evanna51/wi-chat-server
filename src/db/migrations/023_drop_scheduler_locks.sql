-- T-06: drop scheduler_locks table.
-- 该表为多副本调度互斥设计，但本服务架构强制 instances:1 + exec_mode:fork（SQLite 单写硬约束），
-- 锁逻辑永远走单进程内 cron 互斥，scheduler_locks 表纯属冗余。
-- 影响：
--   - schedulerLockService.js 已删
--   - scheduler.js 各 tick 移除 tryAcquireSchedulerLock 调用
--   - browse.js 健康检查里读 scheduler_locks 的代码已移除
--   - config.js 移除 schedulerLeaderId / schedulerLockTtlMs / *LockName

DROP TABLE IF EXISTS scheduler_locks;
