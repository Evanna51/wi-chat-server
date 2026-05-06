#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sync-replay.js — chatbox-Android 离线 push 模拟工具
 *
 * 模式：
 *   --mode generate --assistant <id> --session <id> --count N --out <file>
 *       本地生成 N 条 turn 写到 JSON 文件，模拟手机离线缓存
 *
 *   --mode push --in <file> [--api http://...] [--api-key dev-local-key] [--device-id ...]
 *       把文件中的 turns 分批 POST 给 server
 *
 *   --mode test --assistant <id> --count N
 *       一键端到端：生成 → push → 二次 push 验证幂等
 *
 *   --mode e2e --assistant <id> --count N
 *       Phase 4 端到端：生成 → push → 间隔 2s 再 push → 校验 state 接口 → 等 indexer → 校验 memory_items
 *
 *   --mode tool-roles --assistant <id>
 *       推一组 user → assistant → tool_call → tool_result → system 5 行序列，
 *       验证：(a) 5 行全部 accepted；(b) 重推全部 skipped；(c) memory_items 仅 2 行（user + assistant）；
 *       (d) conversation_turns 里 tool_call/tool_result/system 的列正确填充
 *
 * 通用参数：
 *   --api          默认 http://127.0.0.1:8787
 *   --api-key      默认 dev-local-key
 *   --batch-size   默认 100
 *   --device-id    默认 sync-replay
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { v7: uuidv7 } = require("uuid");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(tok);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const API = String(args.api || "http://127.0.0.1:8787").replace(/\/$/, "");
const API_KEY = String(args["api-key"] || "dev-local-key");
const BATCH_SIZE = Number(args["batch-size"] || 100);
const DEVICE_ID = String(args["device-id"] || "sync-replay");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function generateTurns({ assistantId, sessionId, count }) {
  const out = [];
  const baseTs = Date.now() - count * 1000;
  for (let i = 0; i < count; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant";
    out.push({
      id: uuidv7(),
      assistantId,
      sessionId,
      role,
      content:
        role === "user"
          ? `[offline] 测试消息 #${i + 1} - ${new Date(baseTs + i * 1000).toISOString()}`
          : `[offline] 助手回复 #${i + 1}`,
      createdAt: baseTs + i * 1000,
    });
  }
  return out;
}

async function postJson(urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_e) {
    json = { ok: false, raw: text };
  }
  return { status: res.status, json };
}

async function getJson(urlPath) {
  const res = await fetch(`${API}${urlPath}`, {
    headers: { "x-api-key": API_KEY },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_e) {
    json = { ok: false, raw: text };
  }
  return { status: res.status, json };
}

async function pushTurns(turns) {
  const summary = { accepted: 0, skipped: 0, rejected: 0, details: [] };
  for (let i = 0; i < turns.length; i += BATCH_SIZE) {
    const batch = turns.slice(i, i + BATCH_SIZE);
    const { status, json } = await postJson("/api/sync/push", {
      deviceId: DEVICE_ID,
      turns: batch,
    });
    if (status !== 200 || !json.ok) {
      console.error(`[push] batch ${i / BATCH_SIZE + 1} failed:`, status, JSON.stringify(json));
      throw new Error(`push failed status=${status}`);
    }
    summary.accepted += json.accepted || 0;
    summary.skipped += json.skipped || 0;
    summary.rejected += json.rejected || 0;
    if (Array.isArray(json.details)) {
      summary.details.push(...json.details);
    }
    console.log(
      `[push] batch ${i / BATCH_SIZE + 1}/${Math.ceil(turns.length / BATCH_SIZE)} -> accepted=${json.accepted} skipped=${json.skipped} rejected=${json.rejected}`
    );
  }
  return summary;
}

async function modeGenerate() {
  const assistantId = String(args.assistant || "");
  if (!assistantId) die("--assistant required");
  const sessionId = String(args.session || `${DEVICE_ID}-${uuidv7().slice(0, 8)}`);
  const count = Number(args.count || 10);
  const outPath = String(args.out || path.join(process.cwd(), `sync-buffer-${Date.now()}.json`));
  const turns = generateTurns({ assistantId, sessionId, count });
  fs.writeFileSync(outPath, JSON.stringify({ deviceId: DEVICE_ID, turns }, null, 2));
  console.log(`[generate] wrote ${turns.length} turns to ${outPath}`);
  console.log(`[generate] assistantId=${assistantId} sessionId=${sessionId}`);
}

async function modePush() {
  const inPath = String(args.in || "");
  if (!inPath) die("--in <file> required");
  const raw = JSON.parse(fs.readFileSync(inPath, "utf-8"));
  const turns = Array.isArray(raw) ? raw : raw.turns || [];
  if (!turns.length) die("no turns in file");
  console.log(`[push] sending ${turns.length} turns from ${inPath}`);
  const summary = await pushTurns(turns);
  console.log(
    `[push] done: accepted=${summary.accepted} skipped=${summary.skipped} rejected=${summary.rejected}`
  );
  if (summary.rejected > 0) {
    console.log(
      `[push] rejected sample:`,
      JSON.stringify(summary.details.filter((d) => d.status === "rejected").slice(0, 5), null, 2)
    );
  }
}

async function modeTest() {
  const assistantId = String(args.assistant || "");
  if (!assistantId) die("--assistant required");
  const count = Number(args.count || 5);
  const sessionId = `${DEVICE_ID}-test-${uuidv7().slice(0, 8)}`;
  const turns = generateTurns({ assistantId, sessionId, count });
  const tmpFile = path.join(os.tmpdir(), `sync-replay-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ deviceId: DEVICE_ID, turns }, null, 2));
  console.log(`[test] generated ${count} turns, file=${tmpFile}`);

  console.log(`[test] push #1 (expect all accepted)`);
  const r1 = await pushTurns(turns);
  console.log(
    `[test] #1 result: accepted=${r1.accepted} skipped=${r1.skipped} rejected=${r1.rejected}`
  );

  console.log(`[test] push #2 (expect all skipped)`);
  const r2 = await pushTurns(turns);
  console.log(
    `[test] #2 result: accepted=${r2.accepted} skipped=${r2.skipped} rejected=${r2.rejected}`
  );

  const idempotent = r1.accepted === count && r2.skipped === count && r2.accepted === 0;
  if (idempotent) {
    console.log(`[test] PASS: push idempotency verified (n=${count})`);
  } else {
    console.error(`[test] FAIL: idempotency broken`);
    process.exit(1);
  }
}

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function modeE2E() {
  const assistantId = String(args.assistant || "");
  if (!assistantId) die("--assistant required");
  const count = Number(args.count || 30);
  const sessionId = `${DEVICE_ID}-e2e-${uuidv7().slice(0, 8)}`;

  let pass = true;
  const failures = [];

  // Step 1: 生成
  const turns = generateTurns({ assistantId, sessionId, count });
  console.log(`[e2e] step 1: generated ${count} turns (assistant=${assistantId} session=${sessionId})`);

  // Step 0: snapshot state
  const before = await getJson(
    `/api/sync/state?assistantId=${encodeURIComponent(assistantId)}`
  );
  if (before.status !== 200 || !before.json.ok) {
    pass = false;
    failures.push(`state snapshot before failed: ${before.status} ${JSON.stringify(before.json)}`);
  }
  const beforeCount = before.json?.assistantTurnCount || 0;
  console.log(`[e2e] step 1.5: baseline assistantTurnCount=${beforeCount}`);

  // Step 2: 第一次 push
  console.log(`[e2e] step 2: first push (expect accepted=${count})`);
  const r1 = await pushTurns(turns);
  if (r1.accepted !== count || r1.skipped !== 0 || r1.rejected !== 0) {
    pass = false;
    failures.push(
      `first push expected accepted=${count} skipped=0 rejected=0, got accepted=${r1.accepted} skipped=${r1.skipped} rejected=${r1.rejected}`
    );
  }

  // Step 3: 间隔 2s 再 push
  await sleep(2000);
  console.log(`[e2e] step 3: second push (expect skipped=${count})`);
  const r2 = await pushTurns(turns);
  if (r2.accepted !== 0 || r2.skipped !== count) {
    pass = false;
    failures.push(
      `second push expected accepted=0 skipped=${count}, got accepted=${r2.accepted} skipped=${r2.skipped}`
    );
  }

  // Step 4: state 接口校验
  const after = await getJson(
    `/api/sync/state?assistantId=${encodeURIComponent(assistantId)}`
  );
  if (after.status !== 200 || !after.json.ok) {
    pass = false;
    failures.push(`state after failed: ${after.status} ${JSON.stringify(after.json)}`);
  }
  const afterCount = after.json?.assistantTurnCount || 0;
  if (afterCount - beforeCount !== count) {
    pass = false;
    failures.push(
      `assistantTurnCount delta expected ${count}, got ${afterCount - beforeCount} (before=${beforeCount} after=${afterCount})`
    );
  } else {
    console.log(`[e2e] step 4: assistantTurnCount delta OK (${beforeCount} -> ${afterCount})`);
  }

  // Step 5: 等 indexer / 直接走 DB 校验 memory_items 数量
  console.log(`[e2e] step 5: waiting 5s then checking memory_items...`);
  await sleep(5000);

  // 用 better-sqlite3 直接查（脚本和 server 共享同一份 DB 文件）
  const Database = require("better-sqlite3");
  const config = require("../src/config");
  const dbConn = new Database(config.databasePath, { readonly: true });
  try {
    const ids = turns.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(",");
    const memRow = dbConn
      .prepare(`SELECT COUNT(1) AS c FROM memory_items WHERE source_turn_id IN (${placeholders})`)
      .get(...ids);
    const turnRow = dbConn
      .prepare(
        `SELECT COUNT(1) AS c FROM conversation_turns WHERE id IN (${placeholders})`
      )
      .get(...ids);
    console.log(
      `[e2e] step 5: turn rows=${turnRow.c}, memory_items rows=${memRow.c} (expected ${count} each)`
    );
    if (turnRow.c !== count) {
      pass = false;
      failures.push(`conversation_turns count expected ${count}, got ${turnRow.c}`);
    }
    if (memRow.c !== count) {
      pass = false;
      failures.push(`memory_items count expected ${count}, got ${memRow.c}`);
    }
  } finally {
    dbConn.close();
  }

  // Step 6: report
  console.log("");
  if (pass) {
    console.log(`[e2e] PASS — ${count} turns, idempotency + state + DB consistency verified`);
    process.exit(0);
  } else {
    console.error(`[e2e] FAIL`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

async function modeToolRoles() {
  const assistantId = String(args.assistant || "");
  if (!assistantId) die("--assistant required");
  const sessionId = `${DEVICE_ID}-toolroles-${uuidv7().slice(0, 8)}`;
  const baseTs = Date.now() - 5000;

  // 构造 5 行：user → assistant → tool_call (空 content) → tool_result → system
  const userTurnId = uuidv7();
  const assistantTurnId = uuidv7();
  const toolCallTurnId = uuidv7();
  const toolResultTurnId = uuidv7();
  const systemTurnId = uuidv7();

  const sampleToolCallId = `call_${uuidv7().slice(0, 8)}`;
  const toolCallsJson = JSON.stringify([
    {
      id: sampleToolCallId,
      type: "function",
      function: {
        name: "search_memory",
        arguments: JSON.stringify({ query: "用户喜欢什么", source: "user" }),
      },
    },
  ]);

  const turns = [
    {
      id: userTurnId,
      assistantId,
      sessionId,
      role: "user",
      content: "[tool-roles-test] 帮我查一下我之前说过我喜欢什么",
      createdAt: baseTs,
    },
    {
      id: assistantTurnId,
      assistantId,
      sessionId,
      role: "assistant",
      content: "好的，我帮你查一下。",
      createdAt: baseTs + 1000,
    },
    {
      id: toolCallTurnId,
      assistantId,
      sessionId,
      role: "tool_call",
      content: "", // 空，符合 Android Message.kt:21 注释
      createdAt: baseTs + 2000,
      toolCallsJson,
    },
    {
      id: toolResultTurnId,
      assistantId,
      sessionId,
      role: "tool_result",
      content: JSON.stringify({ ok: true, hits: [{ id: "m1", content: "我喜欢拿铁", score: 0.85 }] }),
      createdAt: baseTs + 3000,
      toolCallId: sampleToolCallId,
      toolName: "search_memory",
    },
    {
      id: systemTurnId,
      assistantId,
      sessionId,
      role: "system",
      content: "[audit] tool round completed in 850ms",
      createdAt: baseTs + 4000,
    },
  ];

  let pass = true;
  const failures = [];

  console.log(`[tool-roles] step 1: push 5-row sequence (user/assistant/tool_call/tool_result/system)`);
  const r1 = await pushTurns(turns);
  if (r1.accepted !== 5 || r1.skipped !== 0 || r1.rejected !== 0) {
    pass = false;
    failures.push(
      `first push expected accepted=5 skipped=0 rejected=0, got accepted=${r1.accepted} skipped=${r1.skipped} rejected=${r1.rejected}; details=${JSON.stringify(r1.details)}`
    );
  }

  console.log(`[tool-roles] step 2: replay (expect skipped=5)`);
  const r2 = await pushTurns(turns);
  if (r2.skipped !== 5 || r2.accepted !== 0) {
    pass = false;
    failures.push(
      `replay expected accepted=0 skipped=5, got accepted=${r2.accepted} skipped=${r2.skipped}`
    );
  }

  console.log(`[tool-roles] step 3: validate DB rows`);
  const Database = require("better-sqlite3");
  const config = require("../src/config");
  const dbConn = new Database(config.databasePath, { readonly: true });
  try {
    const ids = turns.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(",");
    const turnRows = dbConn
      .prepare(
        `SELECT id, role, content, tool_calls_json, tool_call_id, tool_name
           FROM conversation_turns WHERE id IN (${placeholders})
           ORDER BY created_at ASC`
      )
      .all(...ids);
    if (turnRows.length !== 5) {
      pass = false;
      failures.push(`expected 5 conversation_turns rows, got ${turnRows.length}`);
    }
    const byRole = Object.fromEntries(turnRows.map((r) => [r.role, r]));

    if (byRole.tool_call?.tool_calls_json !== toolCallsJson) {
      pass = false;
      failures.push(
        `tool_call row's tool_calls_json mismatch; got=${JSON.stringify(byRole.tool_call?.tool_calls_json)}`
      );
    }
    if (byRole.tool_call?.content !== "") {
      pass = false;
      failures.push(`tool_call content expected empty, got=${JSON.stringify(byRole.tool_call?.content)}`);
    }
    if (byRole.tool_result?.tool_call_id !== sampleToolCallId) {
      pass = false;
      failures.push(`tool_result tool_call_id mismatch`);
    }
    if (byRole.tool_result?.tool_name !== "search_memory") {
      pass = false;
      failures.push(`tool_result tool_name mismatch`);
    }

    // memory_items：只应有 user + assistant 两行（log-only role 不入 memory_items）
    const memRow = dbConn
      .prepare(
        `SELECT COUNT(1) AS c FROM memory_items WHERE source_turn_id IN (${placeholders})`
      )
      .get(...ids);
    if (memRow.c !== 2) {
      pass = false;
      failures.push(`memory_items expected 2 (user+assistant only), got ${memRow.c}`);
    } else {
      console.log(`[tool-roles] memory_items count=2 OK (log-only roles correctly skipped)`);
    }
  } finally {
    dbConn.close();
  }

  console.log("");
  if (pass) {
    console.log(`[tool-roles] PASS — 5-row sequence ingested + idempotent + log-only roles bypassed memory pipeline`);
    process.exit(0);
  } else {
    console.error(`[tool-roles] FAIL`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

(async () => {
  const mode = String(args.mode || "");
  try {
    if (mode === "generate") await modeGenerate();
    else if (mode === "push") await modePush();
    else if (mode === "test") await modeTest();
    else if (mode === "e2e") await modeE2E();
    else if (mode === "tool-roles") await modeToolRoles();
    else {
      console.error("usage:");
      console.error("  --mode generate --assistant <id> [--session <id>] --count N --out <file>");
      console.error("  --mode push --in <file>");
      console.error("  --mode test --assistant <id> --count N");
      console.error("  --mode e2e --assistant <id> --count N");
      console.error("  --mode tool-roles --assistant <id>");
      process.exit(2);
    }
  } catch (error) {
    console.error("[fatal]", error.stack || error.message || error);
    process.exit(1);
  }
})();
