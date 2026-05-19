/**
 * callRegistry.test.js — outbound 调用注册表 + supersede 行为
 */
const { CallRegistry, KIND_DEFAULTS } = require("../src/utils/callRegistry");

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

// ── Suite 1: 基础注册 / 取消 / 列举 ──────────────────────────────────
console.log("\n[Suite 1] register / cancel / list");
{
  const r = new CallRegistry();
  const { callId, signal } = r.register({ kind: "embed", scopeKey: "aid_1", summary: "test embed" });
  assert(typeof callId === "string" && callId.length > 0, "callId returned as string");
  assert(signal instanceof AbortSignal, "signal is AbortSignal");
  assert(signal.aborted === false, "fresh signal not aborted");

  const list = r.list();
  assert(list.length === 1, "registry has 1 entry");
  assert(list[0].kind === "embed", "list entry has kind");
  assert(list[0].scopeKey === "aid_1", "list entry has scopeKey");
  assert(typeof list[0].durationMs === "number", "list entry has durationMs");

  const ok = r.cancel(callId, "manual_test");
  assert(ok === true, "cancel returns true on found");
  assert(signal.aborted === true, "signal aborted after cancel");
  assert(r.list().length === 0, "registry empty after cancel");

  const okAgain = r.cancel(callId, "x");
  assert(okAgain === false, "cancel returns false when not found");
}

// ── Suite 2: unregister 不 abort ─────────────────────────────────────
console.log("\n[Suite 2] unregister cleanup（成功路径）");
{
  const r = new CallRegistry();
  const { callId, signal } = r.register({ kind: "embed" });
  r.unregister(callId);
  assert(r.list().length === 0, "unregister removes entry");
  assert(signal.aborted === false, "unregister does NOT abort signal");
}

// ── Suite 3: supersede（同 kind+scopeKey 的旧调用被自动取消） ─────────
console.log("\n[Suite 3] supersede behavior");
{
  const r = new CallRegistry();
  // KIND_DEFAULTS["chat_reply"].supersede = true
  const first = r.register({ kind: "chat_reply", scopeKey: "aid_X", summary: "first" });
  assert(first.signal.aborted === false, "first chat_reply not aborted yet");

  const second = r.register({ kind: "chat_reply", scopeKey: "aid_X", summary: "second" });
  assert(first.signal.aborted === true, "first auto-aborted by second (supersede)");
  assert(second.signal.aborted === false, "second still alive");
  assert(r.list().length === 1, "only second entry remains");

  // 不同 scope 不互相 supersede
  const otherScope = r.register({ kind: "chat_reply", scopeKey: "aid_Y", summary: "y" });
  assert(second.signal.aborted === false, "different scopeKey does not supersede");
  assert(otherScope.signal.aborted === false, "Y scope alive");
  assert(r.list().length === 2, "two entries (X + Y)");
}

// ── Suite 4: 默认 supersede=false 的 kind 不互相取消 ──────────────────
console.log("\n[Suite 4] non-supersede kinds (embed / reflect / etc)");
{
  const r = new CallRegistry();
  const e1 = r.register({ kind: "embed", scopeKey: "aid_A" });
  const e2 = r.register({ kind: "embed", scopeKey: "aid_A" });
  assert(e1.signal.aborted === false, "embed e1 still alive after e2");
  assert(e2.signal.aborted === false, "embed e2 alive");
  assert(r.list().length === 2, "both embeds in registry");
}

// ── Suite 5: 显式 supersede 覆盖 KIND_DEFAULTS ───────────────────────
console.log("\n[Suite 5] explicit supersede flag overrides default");
{
  const r = new CallRegistry();
  // embed 默认 supersede=false，强制传 true 应该 supersede
  const e1 = r.register({ kind: "embed", scopeKey: "aid_S", supersede: true });
  const e2 = r.register({ kind: "embed", scopeKey: "aid_S", supersede: true });
  assert(e1.signal.aborted === true, "explicit supersede=true takes effect");

  // chat_reply 默认 supersede=true，传 false 应该不 supersede
  const r2 = new CallRegistry();
  const c1 = r2.register({ kind: "chat_reply", scopeKey: "aid_T", supersede: false });
  const c2 = r2.register({ kind: "chat_reply", scopeKey: "aid_T", supersede: false });
  assert(c1.signal.aborted === false, "explicit supersede=false overrides chat_reply default");
  assert(r2.list().length === 2, "both chat_reply entries when supersede=false");
}

// ── Suite 6: cancelByScope 批量取消 ─────────────────────────────────
console.log("\n[Suite 6] cancelByScope");
{
  const r = new CallRegistry();
  const a1 = r.register({ kind: "reflect", scopeKey: "aid_1" });
  const a2 = r.register({ kind: "reflect", scopeKey: "aid_1" });
  const b1 = r.register({ kind: "reflect", scopeKey: "aid_2" });

  const cancelled = r.cancelByScope("reflect", "aid_1", "test_batch");
  assert(cancelled === 2, "cancelByScope returns count");
  assert(a1.signal.aborted && a2.signal.aborted, "both aid_1 calls aborted");
  assert(b1.signal.aborted === false, "aid_2 untouched");
  assert(r.list().length === 1, "only aid_2 remains");
}

// ── Suite 7: scopeKey=null 不参与 supersede ─────────────────────────
console.log("\n[Suite 7] scopeKey=null bypasses supersede");
{
  const r = new CallRegistry();
  const c1 = r.register({ kind: "chat_reply", scopeKey: null });
  const c2 = r.register({ kind: "chat_reply", scopeKey: null });
  assert(c1.signal.aborted === false, "null scopeKey does not supersede");
  assert(r.list().length === 2, "both null-scope entries kept");
}

// ── Suite 8: KIND_DEFAULTS 暴露常用 kind ──────────────────────────────
console.log("\n[Suite 8] KIND_DEFAULTS sanity");
{
  for (const k of ["chat_reply", "catchup", "proactive_plan", "reflect", "embed", "memory_classify", "vector_query", "http"]) {
    assert(typeof KIND_DEFAULTS[k]?.supersede === "boolean", `KIND_DEFAULTS has "${k}"`);
  }
  assert(KIND_DEFAULTS.chat_reply.supersede === true, "chat_reply supersede=true");
  assert(KIND_DEFAULTS.embed.supersede === false, "embed supersede=false");
  assert(KIND_DEFAULTS.http.supersede === false, "http supersede=false");
}

// ── Suite 9: 集成 registeredFetch + AbortError ────────────────────────
console.log("\n[Suite 9] registeredFetch integration (mock fetch)");
(async () => {
  // 用 mock fetch 测：register → cancel → fetch 抛 AbortError
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener("abort", onAbort);
      // 永不 resolve —— 必须由 abort 触发结束
    });
  };

  try {
    const { registeredFetch } = require("../src/utils/registeredFetch");
    const realRegistry = require("../src/utils/callRegistry");
    realRegistry._clearForTests();

    // 启动一个 fetch（不会 resolve），50ms 后从外部取消
    const promise = registeredFetch("https://test.example", {}, {
      kind: "vector_query",
      scopeKey: "aid_int",
      summary: "test",
    });

    // 等 register 完成
    await new Promise((r) => setImmediate(r));
    const inFlight = realRegistry.list();
    assert(inFlight.length === 1, "registeredFetch registered call");
    assert(inFlight[0].kind === "vector_query", "kind correctly forwarded");

    realRegistry.cancel(inFlight[0].callId, "test_external_cancel");

    let caught;
    try { await promise; } catch (e) { caught = e; }
    assert(caught && caught.name === "AbortError", "fetch threw AbortError after cancel");
    assert(realRegistry.list().length === 0, "registry cleaned up after fetch finally");
  } finally {
    global.fetch = originalFetch;
  }

  console.log("\n──────────────────────────────────────────────────");
  console.log(`结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
