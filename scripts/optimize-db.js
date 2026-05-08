#!/usr/bin/env node
/**
 * 一次性 DB 瘦身脚本：跑一轮 retentionSweeper + 强制 VACUUM。
 *
 * 日常运行靠 RETENTION_SWEEP_CRON cron 自己跑（每天 03:30），
 * 这个脚本只用于：
 *   - 第一次启用瘦身策略时消化历史存量
 *   - 临时手动瘦身（例如 db 突然涨得很快想立刻回收）
 *
 * 用法：node scripts/optimize-db.js
 */

const fs = require("fs");
const { db } = require("../src/db");
const config = require("../src/config");
const { runRetentionSweepOnce } = require("../src/workers/retentionSweeper");

function fmtSize(bytes) {
  if (bytes == null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fileSize() {
  try {
    return fs.statSync(config.databasePath).size;
  } catch {
    return null;
  }
}

async function main() {
  const sizeAtStart = fileSize();
  console.log(`[optimize] db path: ${config.databasePath}`);
  console.log(`[optimize] size before: ${fmtSize(sizeAtStart)}`);

  console.log("[optimize] running retention sweep...");
  const sweepResult = await runRetentionSweepOnce();
  console.log("[optimize] sweep counts:", {
    retrievalLog: sweepResult.retrievalLog,
    outboxConsumed: sweepResult.outboxConsumed,
    localAcked: sweepResult.localAcked,
    providerCallLog: sweepResult.providerCallLog,
    auditLog: sweepResult.auditLog,
    behaviorJournalPruned: sweepResult.behaviorJournalPruned,
  });

  // 脚本里强制再跑一次 VACUUM（sweeper 默认只在月初跑），
  // 因为 incremental_vacuum 没开，碎页只能靠 VACUUM 回收
  console.log("[optimize] forcing VACUUM...");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  const sizeAtEnd = fileSize();
  const delta = sizeAtStart != null && sizeAtEnd != null ? sizeAtEnd - sizeAtStart : null;
  console.log(`[optimize] size after:  ${fmtSize(sizeAtEnd)}`);
  if (delta != null) {
    const pct = sizeAtStart > 0 ? ((delta / sizeAtStart) * 100).toFixed(1) : "?";
    console.log(`[optimize] delta: ${fmtSize(delta)} (${pct}%)`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[optimize] failed:", err);
  process.exit(1);
});
