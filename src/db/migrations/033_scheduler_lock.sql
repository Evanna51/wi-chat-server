-- Migration 033: Scheduler Leader Lock
--
-- 解决 cron tick 多 instance 重复触发问题。诊断证据：
--   - reflection_weekly: 2026-05-10 04:30 同一秒 3 角色各 2 条（差 20ms）
--   - plan_generation_tick: 2026-05-10 06:00 同一秒 4 角色各 2 条（差 4ms）
-- 原因：cron.schedule 是 in-process timer，PM2 restart 双进程过渡期 / dev 同时
-- 本地启 server 副本时，多个 instance 都注册并触发 cron。
--
-- 设计：每个 cron tick 用 lock_name 抢一个 short-TTL lock，抢到才跑。
-- ttl 自然过期保证 lock 不会因 holder 崩溃永久持有。
--
-- 已有 reflection 的 24h dedup 是 per-feature 防御；本表是 scheduler 层防御，
-- 两者并存（双重保护）。

CREATE TABLE IF NOT EXISTS scheduler_lock (
  lock_name   TEXT PRIMARY KEY,
  holder_id   TEXT NOT NULL,           -- 抢锁的进程标识（pid + boot_at + 自定义后缀）
  acquired_at INTEGER NOT NULL,        -- 抢锁时间
  expires_at  INTEGER NOT NULL         -- 锁过期时间（acquired_at + ttl_ms）
);

CREATE INDEX IF NOT EXISTS idx_scheduler_lock_expires ON scheduler_lock(expires_at);
