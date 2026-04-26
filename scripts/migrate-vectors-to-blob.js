const path = require("path");
const Database = require("better-sqlite3");
const config = require("../src/config");

const BATCH_SIZE = 500;

function vectorToBlob(vec) {
  const float32 = new Float32Array(vec);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const dbPath = path.resolve(config.databasePath);
  console.log(
    `提醒：本脚本将把 memory_vectors.vector_json 转成 vector_blob，DB 备份已在 data/character-behavior.db.bak.phase2.*；如未备份请 ctrl-c 退出`
  );
  console.log(`目标 DB: ${dbPath}`);
  console.log("3 秒后开始...");
  await wait(3000);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const selectStmt = db.prepare(
    `SELECT memory_item_id, vector_json
     FROM memory_vectors
     WHERE vector_blob IS NULL AND vector_json IS NOT NULL
     LIMIT ?`
  );
  const updateStmt = db.prepare(
    "UPDATE memory_vectors SET vector_blob = ? WHERE memory_item_id = ?"
  );

  let total = 0;
  while (true) {
    const rows = selectStmt.all(BATCH_SIZE);
    if (!rows.length) break;
    const batchTx = db.transaction((items) => {
      for (const row of items) {
        try {
          const vec = JSON.parse(row.vector_json);
          if (!Array.isArray(vec) || !vec.length) {
            console.error(
              `[skip] memory_item_id=${row.memory_item_id} vector_json 不是有效数组`
            );
            continue;
          }
          updateStmt.run(vectorToBlob(vec), row.memory_item_id);
          total += 1;
        } catch (error) {
          console.error(
            `[error] memory_item_id=${row.memory_item_id} ${error.message}`
          );
        }
      }
    });
    try {
      batchTx(rows);
    } catch (error) {
      console.error(`[batch-error] ${error.message}`);
    }
  }

  const remaining = db
    .prepare("SELECT COUNT(1) AS n FROM memory_vectors WHERE vector_blob IS NULL")
    .get().n;
  console.log(`done: ${total}, remaining_with_null: ${remaining}`);
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
