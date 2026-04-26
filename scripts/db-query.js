const Database = require("better-sqlite3");
const path = require("path");
const config = require("../src/config");

function parseArgs(argv) {
  const args = {
    table: "conversation_turns",
    assistantId: "",
    userId: "",
    name: "",
    sessionId: "",
    role: "",
    memoryType: "",
    messageType: "",
    runType: "",
    status: "",
    life: false,
    from: "",
    to: "",
    limit: 20,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--table") args.table = String(argv[++i] || args.table);
    else if (token === "--assistant") args.assistantId = String(argv[++i] || "");
    else if (token === "--user") args.userId = String(argv[++i] || "");
    else if (token === "--name") args.name = String(argv[++i] || "");
    else if (token === "--session") args.sessionId = String(argv[++i] || "");
    else if (token === "--role") args.role = String(argv[++i] || "");
    else if (token === "--memory-type") args.memoryType = String(argv[++i] || "");
    else if (token === "--message-type") args.messageType = String(argv[++i] || "");
    else if (token === "--run-type") args.runType = String(argv[++i] || "");
    else if (token === "--status") args.status = String(argv[++i] || "");
    else if (token === "--life") args.life = true;
    else if (token === "--from") args.from = String(argv[++i] || "");
    else if (token === "--to") args.to = String(argv[++i] || "");
    else if (token === "--limit") args.limit = Number(argv[++i] || 20);
    else if (token === "--json") args.json = true;
    else if (token === "--help") args.help = true;
  }

  return args;
}

function toTs(input, fallback) {
  if (!input) return fallback;
  if (/^\d+$/.test(input)) return Number(input);
  const value = Date.parse(input);
  if (Number.isNaN(value)) throw new Error(`invalid time: ${input}`);
  return value;
}

function buildQuery(args) {
  const allowedTables = new Set([
    "conversation_turns",
    "memory_items",
    "memory_facts",
    "memory_retrieval_log",
    "outbox_events",
    "character_behavior_journal",
    "assistant_profile",
    "proactive_message_log",
    "local_outbox_messages",
    "local_subscribers",
    "push_token",
  ]);
  if (!allowedTables.has(args.table)) {
    throw new Error(`unsupported table: ${args.table}`);
  }
  if (args.life) {
    args.table = "memory_items";
  }

  const where = [];
  const values = [];
  const hasAssistantId = new Set([
    "conversation_turns",
    "memory_items",
    "memory_facts",
    "memory_retrieval_log",
    "memory_vectors",
    "character_behavior_journal",
    "assistant_profile",
    "proactive_message_log",
    "local_outbox_messages",
  ]).has(args.table);
  const hasUserId = new Set(["local_outbox_messages", "local_subscribers", "push_token"]).has(
    args.table
  );
  const hasSessionId = new Set([
    "conversation_turns",
    "memory_items",
    "memory_facts",
    "memory_retrieval_log",
    "character_behavior_journal",
    "proactive_message_log",
    "local_outbox_messages",
  ]).has(args.table);
  const supportsNameLookup = hasAssistantId || args.table === "assistant_profile";

  if (args.name && !supportsNameLookup) {
    throw new Error(`--name is not supported for table: ${args.table}`);
  }

  if (args.assistantId && hasAssistantId) {
    where.push("assistant_id = ?");
    values.push(args.assistantId);
  }
  if (args.userId && hasUserId) {
    where.push("user_id = ?");
    values.push(args.userId);
  }
  if (args.name) {
    if (args.table === "assistant_profile") {
      where.push("character_name LIKE ?");
      values.push(`%${args.name}%`);
    } else if (hasAssistantId) {
      // Join-like filter: resolve assistant ids by character name first, then query target table.
      where.push(
        "assistant_id IN (SELECT assistant_id FROM assistant_profile WHERE character_name LIKE ?)"
      );
      values.push(`%${args.name}%`);
    }
  }
  if (args.sessionId && hasSessionId) {
    where.push("session_id = ?");
    values.push(args.sessionId);
  }
  if (args.role && args.table === "conversation_turns") {
    where.push("role = ?");
    values.push(args.role);
  }
  if (args.runType && args.table === "character_behavior_journal") {
    where.push("run_type = ?");
    values.push(args.runType);
  }
  if (
    args.status &&
    (args.table === "character_behavior_journal" || args.table === "local_outbox_messages")
  ) {
    where.push("status = ?");
    values.push(args.status);
  }
  if (args.messageType && args.table === "local_outbox_messages") {
    where.push("message_type = ?");
    values.push(args.messageType);
  }
  if (args.life) {
    where.push("memory_type IN ('life_event', 'work_event')");
  } else if (args.memoryType && args.table === "memory_items") {
    where.push("memory_type = ?");
    values.push(args.memoryType);
  }

  const hasCreatedAt = new Set([
    "conversation_turns",
    "memory_items",
    "memory_facts",
    "memory_retrieval_log",
    "outbox_events",
    "character_behavior_journal",
    "proactive_message_log",
    "local_outbox_messages",
    "push_token",
    "local_subscribers",
  ]).has(args.table);
  const timeColumn = hasCreatedAt ? "created_at" : "updated_at";

  const fromTs = toTs(args.from, 0);
  const toTsValue = toTs(args.to, Date.now());
  where.push(`${timeColumn} BETWEEN ? AND ?`);
  values.push(fromTs, toTsValue);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM ${args.table} ${whereSql} ORDER BY ${timeColumn} DESC LIMIT ?`;
  values.push(Math.max(1, Math.min(200, Number(args.limit) || 20)));
  return { sql, values };
}

function printHelp() {
  console.log(`
Usage:
  npm run db:query -- --table conversation_turns --assistant <assistant_id> --limit 20
  npm run db:query -- --life --assistant <assistant_id> --limit 20

Options:
  --table      conversation_turns|memory_items|memory_facts|memory_retrieval_log|outbox_events|character_behavior_journal|assistant_profile|proactive_message_log|local_outbox_messages|local_subscribers|push_token
  --assistant  filter assistant_id
  --user       filter user_id (local_outbox_messages|local_subscribers|push_token)
  --name       fuzzy filter character_name, then map to assistant_id (supports multi-match)
  --session    filter session_id
  --role       filter role (only conversation_turns)
  --memory-type  filter memory_type (only memory_items, e.g. life_event|work_event|user_turn|assistant_turn)
  --message-type  filter message_type (only local_outbox_messages, e.g. character_proactive)
  --run-type   filter run_type (only character_behavior_journal, e.g. life_tick|proactive_message_tick)
  --status     filter status (character_behavior_journal|local_outbox_messages)
  --life       shortcut: query memory_items and keep life_event/work_event
  --from       start time (unix ms or ISO), default 0
  --to         end time (unix ms or ISO), default now
  --limit      result size (1-200), default 20
  --json       output json only
  --help       show help

Examples:
  npm run db:query -- --table conversation_turns --assistant d244... --limit 10
  npm run db:query -- --table conversation_turns --name 金琉 --limit 10
  npm run db:query -- --table character_behavior_journal --assistant d244... --run-type life_tick --limit 10
  npm run db:query -- --table local_outbox_messages --user default-user --status pending --limit 20
  npm run db:query -- --table proactive_message_log --assistant d244... --limit 20
  npm run db:query -- --life --assistant d244... --limit 10
  npm run db:query -- --table memory_items --assistant d244... --memory-type life_event --limit 10
  npm run db:query -- --table memory_items --assistant d244... --from "2026-03-13T00:00:00+08:00" --json
  `);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const dbPath = path.resolve(config.databasePath);
  const db = new Database(dbPath, { readonly: true });
  const { sql, values } = buildQuery(args);
  const rows = db.prepare(sql).all(...values);

  if (args.json) {
    console.log(JSON.stringify({ table: args.table, count: rows.length, rows }, null, 2));
    return;
  }

  console.log(`[db-query] table=${args.table} count=${rows.length} db=${dbPath}`);
  for (const row of rows) {
    console.log(row);
  }
}

main();
