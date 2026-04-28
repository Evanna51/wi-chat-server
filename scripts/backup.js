const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const Database = require("better-sqlite3");
const config = require("../src/config");

const INCR_KEEP_DAYS = Number(process.env.BACKUP_INCR_KEEP_DAYS || 8);
const WINDOW_HOURS = 25;

const TABLES = [
  { name: "conversation_turns", timeColumn: "created_at" },
  { name: "memory_items", timeColumn: "created_at" },
  { name: "memory_facts", timeColumn: "created_at" },
  { name: "memory_edges", timeColumn: "created_at" },
  { name: "character_behavior_journal", timeColumn: "created_at" },
  { name: "assistant_profile", timeColumn: null },
];

function backupDir() {
  return path.resolve(path.dirname(config.databasePath), "backups");
}

function dailyFile(now = new Date()) {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return path.join(backupDir(), `incr-${yyyy}-${mm}-${dd}.jsonl.gz`);
}

function detectColumns(db, tableName) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(cols.map((c) => c.name));
}

function buildSinceExpr(colSet, since) {
  const hasCreated = colSet.has("created_at");
  const hasUpdated = colSet.has("updated_at");
  if (hasCreated && hasUpdated) {
    return { expr: "MAX(created_at, updated_at) > ?", params: [since] };
  }
  if (hasCreated) {
    return { expr: "created_at > ?", params: [since] };
  }
  if (hasUpdated) {
    return { expr: "updated_at > ?", params: [since] };
  }
  return null;
}

function pruneOldIncrFiles(keepDays) {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return;
  const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    if (!/^incr-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(name)) continue;
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoffMs) {
      fs.unlinkSync(fullPath);
      console.log(`pruned old incr: ${name}`);
    }
  }
}

async function runDaily(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const sinceMs = opts.sinceMs !== undefined ? opts.sinceMs : now.getTime() - WINDOW_HOURS * 3600 * 1000;

  fs.mkdirSync(backupDir(), { recursive: true });
  const dbPath = path.resolve(config.databasePath);
  const db = new Database(dbPath, { readonly: true });
  const outPath = opts.outPath || dailyFile(now);
  const out = fs.createWriteStream(outPath);
  const gz = zlib.createGzip();
  gz.pipe(out);

  let totalRows = 0;
  const summary = {};
  for (const t of TABLES) {
    const colSet = detectColumns(db, t.name);
    let rows = [];
    const sinceExpr = buildSinceExpr(colSet, sinceMs);
    if (sinceExpr) {
      rows = db
        .prepare(`SELECT * FROM ${t.name} WHERE ${sinceExpr.expr} ORDER BY rowid ASC`)
        .all(...sinceExpr.params);
    } else {
      rows = db.prepare(`SELECT * FROM ${t.name}`).all();
    }
    summary[t.name] = rows.length;
    totalRows += rows.length;
    for (const row of rows) {
      gz.write(JSON.stringify({ _table: t.name, ...row }) + "\n");
    }
  }
  db.close();

  await new Promise((resolve, reject) => {
    gz.end((err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve) => out.on("close", resolve));

  pruneOldIncrFiles(INCR_KEEP_DAYS);

  const fileSize = fs.statSync(outPath).size;
  console.log(`[backup] incr done: ${outPath}`);
  console.log(`[backup] since: ${new Date(sinceMs).toISOString()} (window=${WINDOW_HOURS}h)`);
  console.log(`[backup] rows: ${totalRows}  size: ${fileSize} bytes`);
  for (const [tbl, count] of Object.entries(summary)) {
    console.log(`         ${tbl.padEnd(34)} ${count}`);
  }
  return { outPath, fileSize, totalRows, summary };
}

async function runVerify(filePath) {
  if (!filePath) throw new Error("usage: node scripts/backup.js verify <file>");
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${abs}`);

  const stream = fs.createReadStream(abs).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const head = [];
  const tail = [];
  let lines = 0;
  for await (const line of rl) {
    lines += 1;
    if (head.length < 5) head.push(line);
    else {
      tail.push(line);
      if (tail.length > 5) tail.shift();
    }
  }
  for (const line of [...head, ...tail]) JSON.parse(line);
  console.log(JSON.stringify({ ok: true, lines, file: abs }, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "daily") {
    await runDaily();
    return;
  }
  if (cmd === "verify") {
    await runVerify(process.argv[3]);
    return;
  }
  console.log("用法:");
  console.log("  node scripts/backup.js daily");
  console.log("  node scripts/backup.js verify <file>");
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { runDaily };
