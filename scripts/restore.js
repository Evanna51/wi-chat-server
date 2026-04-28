/**
 * 恢复工具：将全量快照 + 增量文件还原到目标 DB。
 *
 * 用法:
 *   node scripts/restore.js --from <full.sqlite> --db <target.db> [--apply <incr1.gz> <incr2.gz> ...]
 *   node scripts/restore.js --list-incr          列出 data/backups/ 中所有增量文件
 *
 * 选项:
 *   --from <full.sqlite>   全量快照路径（必填，除非 --list-incr）
 *   --db   <target.db>     还原目标路径（默认 config.databasePath）
 *   --apply <files...>     按顺序 upsert 的增量 .jsonl.gz 文件（可选，支持多个）
 *   --dry-run              只打印计划，不写文件
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const Database = require("better-sqlite3");
const config = require("../src/config");

function parseArgs(argv) {
  const args = { apply: [], dryRun: false };
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--from") { args.from = argv[++i]; }
    else if (a === "--db") { args.db = argv[++i]; }
    else if (a === "--apply") {
      i++;
      while (i < argv.length && !argv[i].startsWith("--")) {
        args.apply.push(argv[i++]);
      }
      continue;
    }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--list-incr") { args.listIncr = true; }
    else if (a === "--help" || a === "-h") { args.help = true; }
    else { throw new Error(`未知参数: ${a}`); }
    i++;
  }
  return args;
}

function backupDir() {
  return path.resolve(path.dirname(config.databasePath), "backups");
}

function listIncrFiles() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) { console.log("data/backups/ 不存在"); return; }
  const files = fs.readdirSync(dir)
    .filter((f) => /^incr-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
    .sort();
  if (!files.length) { console.log("无增量文件"); return; }
  for (const f of files) {
    const stat = fs.statSync(path.join(dir, f));
    console.log(`  ${f}  (${(stat.size / 1024).toFixed(1)} KB)`);
  }
}

async function applyIncrFile(db, incrPath) {
  const stmtCache = {};
  const colCache = {};

  function getCols(tableName) {
    if (colCache[tableName]) return colCache[tableName];
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
    colCache[tableName] = cols;
    return cols;
  }

  function getStmt(tableName) {
    if (stmtCache[tableName]) return stmtCache[tableName];
    const cols = getCols(tableName);
    const placeholders = cols.map(() => "?").join(", ");
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO ${tableName} (${cols.join(", ")}) VALUES (${placeholders})`
    );
    stmtCache[tableName] = { stmt, cols };
    return stmtCache[tableName];
  }

  const stream = fs.createReadStream(incrPath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let inserted = 0;
  const batchSize = 200;
  let batch = [];

  const flush = db.transaction((rows) => {
    for (const { tableName, row } of rows) {
      try {
        const { stmt, cols } = getStmt(tableName);
        stmt.run(cols.map((c) => row[c] ?? null));
        inserted += 1;
      } catch (err) {
        console.warn(`  upsert skip (${tableName}): ${err.message}`);
      }
    }
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    const { _table: tableName, ...row } = obj;
    if (!tableName) continue;
    batch.push({ tableName, row });
    if (batch.length >= batchSize) { flush(batch); batch = []; }
  }
  if (batch.length) flush(batch);

  return inserted;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log([
      "用法:",
      "  node scripts/restore.js --from <full.sqlite> --db <target.db> [--apply <incr1.gz> ...]",
      "  node scripts/restore.js --list-incr",
      "",
      "选项:",
      "  --from     全量快照路径（必填）",
      "  --db       还原目标路径（默认 databasePath）",
      "  --apply    增量文件列表（按时间顺序）",
      "  --dry-run  只打印计划，不写入",
    ].join("\n"));
    return;
  }

  if (args.listIncr) { listIncrFiles(); return; }

  if (!args.from) throw new Error("--from <full.sqlite> 必填");
  const srcFull = path.resolve(args.from);
  if (!fs.existsSync(srcFull)) throw new Error(`全量文件不存在: ${srcFull}`);

  const targetDb = path.resolve(args.db || config.databasePath);

  console.log(`[restore] 全量快照: ${srcFull}`);
  console.log(`[restore] 目标 DB:  ${targetDb}`);
  if (args.apply.length) {
    console.log(`[restore] 增量文件: ${args.apply.length} 个`);
    for (const f of args.apply) console.log(`  ${f}`);
  }

  if (args.dryRun) {
    console.log("[restore] --dry-run 模式，不写入");
    return;
  }

  if (fs.existsSync(targetDb)) {
    const bak = `${targetDb}.restore-bak.${Date.now()}`;
    fs.copyFileSync(targetDb, bak);
    console.log(`[restore] 已备份原 DB 到: ${bak}`);
  }

  fs.copyFileSync(srcFull, targetDb);
  console.log(`[restore] 已复制全量快照 → ${targetDb}`);

  if (!args.apply.length) {
    console.log("[restore] 无增量文件，完成");
    return;
  }

  const db = new Database(targetDb);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");

  for (const incrPath of args.apply.sort()) {
    const abs = path.resolve(incrPath);
    if (!fs.existsSync(abs)) { console.warn(`  跳过不存在的文件: ${abs}`); continue; }
    console.log(`[restore] 应用增量: ${path.basename(abs)}`);
    const count = await applyIncrFile(db, abs);
    console.log(`  upserted ${count} 行`);
  }

  db.pragma("foreign_keys = ON");
  db.close();
  console.log("[restore] 完成");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
