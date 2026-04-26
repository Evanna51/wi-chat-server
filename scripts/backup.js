const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const Database = require("better-sqlite3");
const config = require("../src/config");

const TABLES = [
  { name: "conversation_turns", timeColumn: "created_at" },
  { name: "memory_items", timeColumn: "created_at" },
  { name: "memory_facts", timeColumn: "created_at" },
  { name: "memory_edges", timeColumn: "created_at" },
  { name: "character_behavior_journal", timeColumn: "created_at" },
  { name: "assistant_profile", timeColumn: null },
];

function backupDir() {
  return path.resolve(path.dirname(config.databasePath), "backup");
}

function lastBackupAtPath() {
  return path.join(backupDir(), ".last_backup_at");
}

function readLastBackupAt() {
  const file = lastBackupAtPath();
  if (!fs.existsSync(file)) return 0;
  const raw = fs.readFileSync(file, "utf8").trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function writeLastBackupAt(ts) {
  fs.writeFileSync(lastBackupAtPath(), String(ts));
}

function monthlyFile() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return path.join(backupDir(), `incr-${yyyy}-${mm}.jsonl.gz`);
}

function detectTimeColumn(db, tableName, fallback) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const names = new Set(cols.map((c) => c.name));
  if (fallback && names.has(fallback)) return fallback;
  if (names.has("created_at")) return "created_at";
  if (names.has("updated_at")) return "updated_at";
  return null;
}

async function runMonthly() {
  fs.mkdirSync(backupDir(), { recursive: true });
  const since = readLastBackupAt();
  const dbPath = path.resolve(config.databasePath);
  const db = new Database(dbPath, { readonly: true });
  const outPath = monthlyFile();
  const out = fs.createWriteStream(outPath, { flags: "a" });
  const gz = zlib.createGzip();
  gz.pipe(out);

  let maxTs = since;
  const summary = {};
  for (const t of TABLES) {
    const timeCol = detectTimeColumn(db, t.name, t.timeColumn);
    let rows = [];
    if (timeCol) {
      rows = db
        .prepare(`SELECT * FROM ${t.name} WHERE ${timeCol} > ? ORDER BY ${timeCol} ASC`)
        .all(since);
    } else {
      rows = db.prepare(`SELECT * FROM ${t.name}`).all();
    }
    summary[t.name] = { rows: rows.length, timeCol };
    for (const row of rows) {
      const ts = timeCol ? Number(row[timeCol]) : null;
      if (ts && ts > maxTs) maxTs = ts;
      const obj = { _table: t.name, ...row };
      gz.write(JSON.stringify(obj) + "\n");
    }
  }
  db.close();

  await new Promise((resolve, reject) => {
    gz.end((err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve) => out.on("close", resolve));

  if (maxTs > since) {
    writeLastBackupAt(maxTs);
  }
  const fileSize = fs.statSync(outPath).size;

  console.log(`backup file: ${outPath}`);
  console.log(`since:       ${since} (${since ? new Date(since).toISOString() : "epoch"})`);
  console.log(`new max ts:  ${maxTs} (${maxTs ? new Date(maxTs).toISOString() : "n/a"})`);
  console.log("table rows:");
  for (const [tableName, s] of Object.entries(summary)) {
    console.log(`  ${tableName.padEnd(32)} ${s.rows}  (timeCol=${s.timeCol || "ALL"})`);
  }
  console.log(`file size: ${fileSize} bytes`);
}

async function runVerify(filePath) {
  if (!filePath) {
    throw new Error("usage: node scripts/backup.js verify <file>");
  }
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`文件不存在: ${abs}`);
  }
  const stream = fs.createReadStream(abs).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const head = [];
  const tail = [];
  let lines = 0;
  for await (const line of rl) {
    lines += 1;
    if (head.length < 5) {
      head.push(line);
    } else {
      tail.push(line);
      if (tail.length > 5) tail.shift();
    }
  }

  for (const line of head) {
    JSON.parse(line);
  }
  for (const line of tail) {
    JSON.parse(line);
  }

  console.log(JSON.stringify({ ok: true, lines, file: abs }, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "monthly") {
    await runMonthly();
    return;
  }
  if (cmd === "verify") {
    await runVerify(process.argv[3]);
    return;
  }
  console.log("用法:");
  console.log("  node scripts/backup.js monthly");
  console.log("  node scripts/backup.js verify <file>");
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
