const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../src/config");

const ARCHIVED_TABLES = [
  "conversation_turns",
  "memory_items",
  "memory_facts",
  "memory_edges",
  "character_behavior_journal",
];

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--year") {
      args.year = Number(argv[++i]);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }
  return args;
}

function yearRangeMs(year) {
  const start = Date.UTC(year, 0, 1, 0, 0, 0);
  const end = Date.UTC(year + 1, 0, 1, 0, 0, 0);
  return { start, end };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function dryRun(db, year) {
  const { start, end } = yearRangeMs(year);
  const rows = [];
  for (const table of [...ARCHIVED_TABLES, "memory_vectors"]) {
    let count;
    if (table === "memory_vectors") {
      count = db
        .prepare(
          `SELECT COUNT(1) AS n
           FROM memory_vectors v
           JOIN memory_items m ON m.id = v.memory_item_id
           WHERE m.created_at >= ? AND m.created_at < ?`
        )
        .get(start, end).n;
    } else {
      count = db
        .prepare(`SELECT COUNT(1) AS n FROM ${table} WHERE created_at >= ? AND created_at < ?`)
        .get(start, end).n;
    }
    rows.push({ table, count });
  }
  console.log(`年份 ${year}  范围 [${new Date(start).toISOString()} ~ ${new Date(end).toISOString()})`);
  console.log("---- dry-run ----");
  for (const row of rows) {
    console.log(`  ${row.table.padEnd(32)} ${row.count}`);
  }
  console.log(`总计: ${rows.reduce((s, r) => s + r.count, 0)} 行待归档`);
}

function realRun(srcPath, year) {
  const archiveDir = path.resolve(path.dirname(srcPath), "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `archive-${year}.db`);
  if (fs.existsSync(archivePath)) {
    throw new Error(`目标已存在 ${archivePath}，请先手动删除后再跑`);
  }

  const { start, end } = yearRangeMs(year);
  const main = new Database(srcPath);
  main.pragma("foreign_keys = ON");

  console.log(`step 1/6 VACUUM INTO ${archivePath}`);
  main.prepare(`VACUUM INTO ?`).run(archivePath);
  main.close();

  console.log(`step 2/6 在 archive DB 里删非 ${year} 数据`);
  const archive = new Database(archivePath);
  archive.pragma("foreign_keys = OFF");
  const archiveStats = {};
  const archiveTx = archive.transaction(() => {
    for (const table of ARCHIVED_TABLES) {
      const before = archive.prepare(`SELECT COUNT(1) AS n FROM ${table}`).get().n;
      archive
        .prepare(`DELETE FROM ${table} WHERE NOT (created_at >= ? AND created_at < ?)`)
        .run(start, end);
      const after = archive.prepare(`SELECT COUNT(1) AS n FROM ${table}`).get().n;
      archiveStats[table] = { kept: after, dropped: before - after };
    }
    const beforeVec = archive.prepare(`SELECT COUNT(1) AS n FROM memory_vectors`).get().n;
    archive
      .prepare(
        `DELETE FROM memory_vectors
         WHERE memory_item_id NOT IN (SELECT id FROM memory_items)`
      )
      .run();
    const afterVec = archive.prepare(`SELECT COUNT(1) AS n FROM memory_vectors`).get().n;
    archiveStats.memory_vectors = { kept: afterVec, dropped: beforeVec - afterVec };
  });
  archiveTx();

  console.log(`step 3/6 主库删除 ${year} 数据`);
  const mainDb = new Database(srcPath);
  mainDb.pragma("foreign_keys = OFF");
  const mainStats = {};
  const mainTx = mainDb.transaction(() => {
    const targetItemIds = mainDb
      .prepare(`SELECT id FROM memory_items WHERE created_at >= ? AND created_at < ?`)
      .all(start, end)
      .map((r) => r.id);

    if (targetItemIds.length) {
      const placeholders = targetItemIds.map(() => "?").join(",");
      const beforeVec = mainDb.prepare(`SELECT COUNT(1) AS n FROM memory_vectors`).get().n;
      mainDb
        .prepare(`DELETE FROM memory_vectors WHERE memory_item_id IN (${placeholders})`)
        .run(...targetItemIds);
      const afterVec = mainDb.prepare(`SELECT COUNT(1) AS n FROM memory_vectors`).get().n;
      mainStats.memory_vectors = { deleted: beforeVec - afterVec };
    } else {
      mainStats.memory_vectors = { deleted: 0 };
    }

    for (const table of ARCHIVED_TABLES) {
      const result = mainDb
        .prepare(`DELETE FROM ${table} WHERE created_at >= ? AND created_at < ?`)
        .run(start, end);
      mainStats[table] = { deleted: result.changes };
    }
  });
  mainTx();

  console.log("step 4/6 archive VACUUM");
  archive.exec("VACUUM");
  archive.close();

  console.log("step 5/6 主库 VACUUM + WAL truncate");
  mainDb.exec("VACUUM");
  mainDb.pragma("wal_checkpoint(TRUNCATE)");
  mainDb.close();

  console.log("step 6/6 chmod 444 archive 文件 (只读)");
  fs.chmodSync(archivePath, 0o444);

  const archiveSize = fs.statSync(archivePath).size;
  const mainSize = fs.statSync(srcPath).size;
  console.log("---- 归档完成 ----");
  console.log(`年份: ${year}`);
  console.log(`archive 文件: ${archivePath}  (${fmtBytes(archiveSize)})`);
  console.log(`主库当前: ${srcPath}  (${fmtBytes(mainSize)})`);
  console.log("archive 中各表保留行数:");
  for (const [t, s] of Object.entries(archiveStats)) {
    console.log(`  ${t.padEnd(32)} kept=${s.kept}`);
  }
  console.log("主库中各表删除行数:");
  for (const [t, s] of Object.entries(mainStats)) {
    console.log(`  ${t.padEnd(32)} deleted=${s.deleted}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.year) {
    console.log("用法: node scripts/archive-year.js --year <YYYY> [--dry-run]");
    process.exit(args.help ? 0 : 1);
  }
  if (!Number.isInteger(args.year) || args.year < 2000 || args.year > 9999) {
    throw new Error(`非法年份: ${args.year}`);
  }
  const dbPath = path.resolve(config.databasePath);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB 文件不存在: ${dbPath}`);
  }

  if (args.dryRun) {
    const db = new Database(dbPath, { readonly: true });
    try {
      dryRun(db, args.year);
    } finally {
      db.close();
    }
    return;
  }

  realRun(dbPath, args.year);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
