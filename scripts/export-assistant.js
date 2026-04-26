const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../src/config");

function parseArgs(argv) {
  const args = { includeArchive: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--assistant") args.assistant = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--include-archive") args.includeArchive = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown arg: ${arg}`);
  }
  return args;
}

const TABLES_BY_ASSISTANT = [
  "assistant_profile",
  "character_state",
  "conversation_turns",
  "memory_items",
  "memory_facts",
  "memory_edges",
  "character_behavior_journal",
];

function tableHasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

function exportFromHandle(db, schemaPrefix, assistantId, writeLine) {
  const counts = {};
  for (const tableName of TABLES_BY_ASSISTANT) {
    const fullName = schemaPrefix ? `${schemaPrefix}.${tableName}` : tableName;
    let exists;
    try {
      const probeName = schemaPrefix
        ? `${schemaPrefix}.sqlite_master`
        : "sqlite_master";
      exists = db
        .prepare(`SELECT 1 FROM ${probeName} WHERE type='table' AND name=?`)
        .get(tableName);
    } catch (e) {
      exists = false;
    }
    if (!exists) {
      counts[tableName] = 0;
      continue;
    }
    const rows = db
      .prepare(`SELECT * FROM ${fullName} WHERE assistant_id = ?`)
      .all(assistantId);
    counts[tableName] = rows.length;
    for (const row of rows) {
      writeLine({ _table: tableName, ...row });
    }
  }

  const vecExists = (() => {
    try {
      const probeName = schemaPrefix
        ? `${schemaPrefix}.sqlite_master`
        : "sqlite_master";
      return !!db
        .prepare(`SELECT 1 FROM ${probeName} WHERE type='table' AND name='memory_vectors'`)
        .get();
    } catch (e) {
      return false;
    }
  })();
  if (vecExists) {
    const memoryVectorsName = schemaPrefix
      ? `${schemaPrefix}.memory_vectors`
      : "memory_vectors";
    const memoryItemsName = schemaPrefix
      ? `${schemaPrefix}.memory_items`
      : "memory_items";
    const hasBlob = tableHasColumn(
      db,
      schemaPrefix ? `${schemaPrefix}.memory_vectors` : "memory_vectors",
      "vector_blob"
    );
    const rows = db
      .prepare(
        `SELECT v.memory_item_id, v.assistant_id, v.vector_dim, v.updated_at${hasBlob ? ", v.vector_blob" : ""}
         FROM ${memoryVectorsName} v
         JOIN ${memoryItemsName} m ON m.id = v.memory_item_id
         WHERE m.assistant_id = ?`
      )
      .all(assistantId);
    counts.memory_vectors = rows.length;
    for (const row of rows) {
      const out = {
        _table: "memory_vectors",
        memory_item_id: row.memory_item_id,
        assistant_id: row.assistant_id,
        vector_dim: row.vector_dim,
        updated_at: row.updated_at,
      };
      if (hasBlob && row.vector_blob) {
        out.vector_blob_b64 = Buffer.from(row.vector_blob).toString("base64");
      }
      writeLine(out);
    }
  } else {
    counts.memory_vectors = 0;
  }
  return counts;
}

function listArchiveDbs(dataDir) {
  const archiveDir = path.join(dataDir, "archive");
  if (!fs.existsSync(archiveDir)) return [];
  return fs
    .readdirSync(archiveDir)
    .filter((name) => /^archive-\d{4}\.db$/.test(name))
    .map((name) => path.join(archiveDir, name))
    .sort();
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.assistant) {
    console.log(
      "用法: node scripts/export-assistant.js --assistant <id> [--out <path>] [--include-archive]"
    );
    process.exit(args.help ? 0 : 1);
  }
  const dbPath = path.resolve(config.databasePath);
  if (!fs.existsSync(dbPath)) throw new Error(`DB 文件不存在: ${dbPath}`);

  const exportDir = path.resolve(path.dirname(dbPath), "..", "exports");
  fs.mkdirSync(exportDir, { recursive: true });
  const outPath = path.resolve(args.out || path.join(exportDir, `${args.assistant}.jsonl`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const stream = fs.createWriteStream(outPath);
  let totalLines = 0;
  const writeLine = (obj) => {
    stream.write(JSON.stringify(obj) + "\n");
    totalLines += 1;
  };

  const db = new Database(dbPath, { readonly: true });
  console.log(`source DB: ${dbPath}`);
  const mainCounts = exportFromHandle(db, null, args.assistant, writeLine);
  console.log("主库导出行数:");
  for (const [t, n] of Object.entries(mainCounts)) {
    console.log(`  ${t.padEnd(32)} ${n}`);
  }
  db.close();

  const archiveCountsAgg = {};
  if (args.includeArchive) {
    const dataDir = path.resolve(path.dirname(dbPath));
    const archives = listArchiveDbs(dataDir);
    if (!archives.length) {
      console.log("(无 archive db)");
    }
    for (const archivePath of archives) {
      const arch = new Database(archivePath, { readonly: true });
      console.log(`archive: ${archivePath}`);
      const counts = exportFromHandle(arch, null, args.assistant, writeLine);
      for (const [t, n] of Object.entries(counts)) {
        archiveCountsAgg[t] = (archiveCountsAgg[t] || 0) + n;
        console.log(`  ${t.padEnd(32)} ${n}`);
      }
      arch.close();
    }
  }

  stream.end();

  console.log("---- export 完成 ----");
  console.log(`out file: ${outPath}`);
  console.log(`total lines: ${totalLines}`);
  if (args.includeArchive && Object.keys(archiveCountsAgg).length) {
    console.log("archive 合计:");
    for (const [t, n] of Object.entries(archiveCountsAgg)) {
      console.log(`  ${t.padEnd(32)} ${n}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
