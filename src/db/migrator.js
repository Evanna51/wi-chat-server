const fs = require("fs");
const path = require("path");

function runMigrations(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const hasMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ? LIMIT 1");
  const recordMigration = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)"
  );

  for (const fileName of files) {
    if (hasMigration.get(fileName)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, fileName), "utf8");
    const now = Date.now();
    const tx = db.transaction(() => {
      db.exec(sql);
      recordMigration.run(fileName, now);
    });
    tx();
    console.log(`[db] migration applied: ${fileName}`);
  }
}

module.exports = { runMigrations };
