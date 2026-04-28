const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../src/config");

const FULL_KEEP_WEEKS = Number(process.env.BACKUP_FULL_KEEP_WEEKS || 4);

function backupDir() {
  return path.resolve(path.dirname(config.databasePath), "backups");
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function fullFile(now = new Date()) {
  const { year, week } = isoWeek(now);
  const ww = String(week).padStart(2, "0");
  return path.join(backupDir(), `full-${year}-W${ww}.sqlite`);
}

function fmtBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function pruneOldFullFiles(keepWeeks) {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return;
  const cutoffMs = Date.now() - keepWeeks * 7 * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    if (!/^full-\d{4}-W\d{2}\.sqlite$/.test(name)) continue;
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoffMs) {
      fs.unlinkSync(fullPath);
      console.log(`[full-backup] pruned old full: ${name}`);
    }
  }
}

function runFullBackup(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const srcPath = path.resolve(config.databasePath);
  if (!fs.existsSync(srcPath)) throw new Error(`DB 不存在: ${srcPath}`);

  fs.mkdirSync(backupDir(), { recursive: true });
  const destPath = opts.destPath || fullFile(now);

  if (fs.existsSync(destPath)) {
    console.log(`[full-backup] 本周全量已存在，跳过: ${destPath}`);
    return { skipped: true, destPath };
  }

  const db = new Database(srcPath);
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
    db.prepare("VACUUM INTO ?").run(destPath);
  } finally {
    db.close();
  }

  pruneOldFullFiles(FULL_KEEP_WEEKS);

  const size = fs.statSync(destPath).size;
  const srcSize = fs.statSync(srcPath).size;
  console.log(`[full-backup] done: ${destPath}  (${fmtBytes(size)}, src=${fmtBytes(srcSize)})`);
  return { skipped: false, destPath, size };
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "run") {
    runFullBackup();
    return;
  }
  if (cmd === "--help" || cmd === "-h") {
    console.log("用法: node scripts/full-backup.js [run]");
    return;
  }
  console.error(`未知命令: ${cmd}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

module.exports = { runFullBackup };
