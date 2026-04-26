const DEFAULT_API_KEY = "dev-local-key";

const state = {
  health: null,
  stats: null,
};

function getApiKey() {
  try {
    return localStorage.getItem("apiKey") || DEFAULT_API_KEY;
  } catch {
    return DEFAULT_API_KEY;
  }
}

async function request(method, path, { params, body } = {}) {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, v);
    }
  }
  const init = {
    method,
    headers: {
      "x-api-key": getApiKey(),
    },
  };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url.toString(), init);
  const json = await res.json().catch(() => ({ ok: false, error: `bad_json_${res.status}` }));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `http_${res.status}`);
    err.payload = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

const api = {
  get: (path, params) => request("GET", path, { params }),
  post: (path, body) => request("POST", path, { body }),
  patch: (path, body) => request("PATCH", path, { body }),
};

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(ts) {
  if (!ts) return "—";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function shortText(s, n = 80) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, n) + "…";
}

function showToast(message, kind = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast--leaving");
    setTimeout(() => el.remove(), 300);
  }, 2200);
}

function startHealthPing() {
  const dot = document.getElementById("health-indicator");
  if (!dot) return;
  let active = true;
  async function tick() {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      if (j && j.ok) {
        dot.className = "health-dot health-dot--ok";
        dot.title = `up | ts=${j.ts}`;
      } else {
        dot.className = "health-dot health-dot--bad";
      }
    } catch {
      dot.className = "health-dot health-dot--bad";
    }
    if (active) setTimeout(tick, 1000);
  }
  tick();
}

const root = () => document.getElementById("app-root");

function clearRoot() {
  const el = root();
  el.innerHTML = "";
  return el;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== false && v !== null && v !== undefined) {
      node.setAttribute(k, v);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

async function viewHome() {
  const container = clearRoot();
  container.appendChild(el("article", { "aria-busy": "true" }, "加载主页…"));

  let assistantsResp;
  let statsResp;
  let configResp;
  try {
    [assistantsResp, statsResp, configResp] = await Promise.all([
      api.get("/api/browse/assistants"),
      api.get("/api/browse/stats"),
      api.get("/api/browse/config"),
    ]);
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("article", {}, [
      el("h3", {}, "加载失败"),
      el("pre", {}, err.message),
    ]));
    return;
  }
  state.stats = statsResp;

  container.innerHTML = "";

  const stats = statsResp;
  const totalRows = Object.values(stats.tables || {})
    .filter((n) => typeof n === "number")
    .reduce((a, b) => a + b, 0);

  const summary = el("article", { class: "summary-card" }, [
    el("header", {}, [el("strong", {}, "服务概况")]),
    el("div", { class: "summary-grid" }, [
      el("div", {}, [
        el("small", {}, "DB 大小"),
        el("div", { class: "metric" }, formatBytes(stats.db.sizeBytes)),
      ]),
      el("div", {}, [
        el("small", {}, "总行数"),
        el("div", { class: "metric" }, String(totalRows)),
      ]),
      el("div", {}, [
        el("small", {}, "对话"),
        el("div", { class: "metric" }, String(stats.tables.conversation_turns ?? 0)),
      ]),
      el("div", {}, [
        el("small", {}, "记忆"),
        el("div", { class: "metric" }, String(stats.tables.memory_items ?? 0)),
      ]),
      el("div", {}, [
        el("small", {}, "行为日志"),
        el("div", { class: "metric" }, String(stats.tables.character_behavior_journal ?? 0)),
      ]),
    ]),
  ]);
  container.appendChild(summary);

  const list = assistantsResp.assistants || [];
  const grid = el("section", { class: "card-grid" });
  if (!list.length) {
    grid.appendChild(el("article", {}, "暂无角色，调用 /api/assistant-profile/upsert 创建一个再回来。"));
  }
  for (const a of list) {
    const card = el("article", { class: "char-card" }, [
      el("header", {}, [
        el("strong", { class: "char-card__name" }, a.characterName || a.assistantId),
        el("small", { class: "char-card__id" }, a.assistantId),
      ]),
      el("div", { class: "badge-row" }, [
        el(
          "span",
          {
            class: `badge ${a.allowAutoLife ? "badge--on" : "badge--off"}`,
            title: "allow_auto_life",
          },
          `自驱生活: ${a.allowAutoLife ? "on" : "off"}`
        ),
        el(
          "span",
          {
            class: `badge ${a.allowProactiveMessage ? "badge--on" : "badge--off"}`,
            title: "allow_proactive_message",
          },
          `主动消息: ${a.allowProactiveMessage ? "on" : "off"}`
        ),
        el(
          "span",
          { class: "badge badge--neutral", title: "familiarity" },
          `熟悉度: ${a.state?.familiarity ?? 0}/100`
        ),
      ]),
      el("div", { class: "char-card__counts" }, [
        el("span", {}, `对话 ${a.counts.conversationTurns}`),
        el("span", {}, `记忆 ${a.counts.memoryItems}`),
        el("span", {}, `行为 ${a.counts.journalEntries}`),
      ]),
      el("footer", {}, [
        el(
          "a",
          {
            href: `#/character/${encodeURIComponent(a.assistantId)}`,
            role: "button",
            class: "outline",
          },
          "进入"
        ),
      ]),
    ]);
    grid.appendChild(card);
  }
  container.appendChild(grid);

  const cfg = configResp.config;
  const cfgBlock = el("article", { class: "config-block" }, [
    el("header", {}, [el("strong", {}, "调度与全局配置（只读）")]),
    el("dl", { class: "config-dl" }, [
      el("dt", {}, "life cron"),
      el("dd", {}, cfg.lifeMemoryCron),
      el("dt", {}, "proactive cron"),
      el("dd", {}, cfg.proactiveMessageCron),
      el("dt", {}, "retention cron"),
      el("dd", {}, cfg.retentionSweepCron),
      el("dt", {}, "dryRun（默认）"),
      el("dd", {}, String(cfg.autonomousDryRun)),
      el("dt", {}, "push enabled"),
      el("dd", {}, String(cfg.autonomousPushEnabled)),
      el("dt", {}, "quiet hours"),
      el("dd", {}, cfg.autonomousQuietHours),
      el("dt", {}, "timezone"),
      el("dd", {}, cfg.timezone),
    ]),
  ]);
  container.appendChild(cfgBlock);
}

async function viewSearch() {
  const container = clearRoot();
  const formArea = el("article", {}, [
    el("header", {}, [el("strong", {}, "搜索（FTS5）")]),
    el("form", { id: "search-form" }, [
      el("div", { class: "grid" }, [
        el("label", {}, [
          "Assistant ID",
          el("input", { id: "search-assistant", placeholder: "assistant id（必填）", required: "true" }),
        ]),
        el("label", {}, [
          "范围",
          (() => {
            const sel = el("select", { id: "search-scope" });
            for (const opt of [
              { value: "both", text: "对话 + 记忆" },
              { value: "conversation", text: "仅对话" },
              { value: "memory", text: "仅记忆" },
            ]) {
              sel.appendChild(el("option", { value: opt.value }, opt.text));
            }
            return sel;
          })(),
        ]),
      ]),
      el("input", { id: "search-q", placeholder: "搜索关键词，如 拿铁", required: "true" }),
      el("button", { type: "submit" }, "搜索"),
    ]),
  ]);
  container.appendChild(formArea);
  const results = el("section", { id: "search-results" });
  container.appendChild(results);

  const form = document.getElementById("search-form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const assistantId = document.getElementById("search-assistant").value.trim();
    const q = document.getElementById("search-q").value.trim();
    const scope = document.getElementById("search-scope").value;
    if (!assistantId || !q) return;
    results.innerHTML = "";
    results.appendChild(el("article", { "aria-busy": "true" }, "搜索中…"));
    try {
      const resp = await api.post("/api/search", { assistantId, q, scope, limit: 30 });
      results.innerHTML = "";
      const hits = resp.hits || [];
      if (!hits.length) {
        results.appendChild(el("article", {}, "未命中。"));
        return;
      }
      const tokens = q.split(/\s+/).filter(Boolean);
      function highlight(content) {
        let html = escapeHtml(content);
        for (const t of tokens) {
          if (!t) continue;
          const safe = escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          html = html.replace(new RegExp(safe, "gi"), (m) => `<mark>${m}</mark>`);
        }
        return html;
      }
      for (const h of hits) {
        const card = el("article", { class: "search-hit" });
        card.appendChild(
          el("header", {}, [
            el("span", { class: `badge badge--neutral` }, h.kind),
            " ",
            el("small", {}, formatTime(h.createdAt)),
            " ",
            el("small", {}, `score=${(h.score || 0).toFixed(3)}`),
            h.role ? el("small", {}, ` role=${h.role}`) : null,
            h.memoryType ? el("small", {}, ` type=${h.memoryType}`) : null,
          ])
        );
        const body = el("p", { class: "hit-body" });
        body.innerHTML = highlight(h.content || "");
        card.appendChild(body);
        if (h.kind === "conversation") {
          card.appendChild(
            el("a", { href: `#/character/${encodeURIComponent(assistantId)}/conversation` }, "查看对话")
          );
        } else if (h.kind === "memory") {
          card.appendChild(
            el("a", { href: `#/character/${encodeURIComponent(assistantId)}/memory` }, "查看记忆")
          );
        }
        results.appendChild(card);
      }
    } catch (err) {
      results.innerHTML = "";
      results.appendChild(el("article", {}, [
        el("h4", {}, "搜索失败"),
        el("pre", {}, err.message),
      ]));
    }
  });
}

const TABS = [
  { id: "overview", label: "概览" },
  { id: "conversation", label: "对话" },
  { id: "memory", label: "记忆" },
  { id: "journal", label: "行为日志" },
  { id: "facts", label: "事实" },
  { id: "manage", label: "管理" },
];

async function viewCharacter(assistantId, tabId = "overview") {
  const container = clearRoot();
  container.appendChild(el("article", { "aria-busy": "true" }, "加载角色…"));

  let resp;
  try {
    resp = await api.get(`/api/browse/assistants/${encodeURIComponent(assistantId)}`);
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("article", {}, [
      el("h3", {}, "未找到角色"),
      el("pre", {}, err.message),
      el("a", { href: "#/" }, "返回主页"),
    ]));
    return;
  }
  const a = resp.assistant;
  container.innerHTML = "";

  const head = el("section", { class: "char-head" }, [
    el("h2", {}, a.characterName || a.assistantId),
    el("small", { class: "muted mono" }, a.assistantId),
    el("div", { class: "badge-row" }, [
      el(
        "span",
        { class: `badge ${a.allowAutoLife ? "badge--on" : "badge--off"}` },
        `自驱生活: ${a.allowAutoLife ? "on" : "off"}`
      ),
      el(
        "span",
        { class: `badge ${a.allowProactiveMessage ? "badge--on" : "badge--off"}` },
        `主动消息: ${a.allowProactiveMessage ? "on" : "off"}`
      ),
      el("span", { class: "badge badge--neutral" }, `熟悉度: ${a.state?.familiarity ?? 0}/100`),
      el("span", { class: "badge badge--neutral" }, `轮次: ${a.state?.totalTurns ?? 0}`),
    ]),
  ]);
  container.appendChild(head);

  const tabBar = el("nav", { class: "tab-bar" });
  const tabUl = el("ul");
  for (const t of TABS) {
    const link = el(
      "a",
      {
        href: `#/character/${encodeURIComponent(assistantId)}/${t.id}`,
        class: t.id === tabId ? "tab-active" : "",
      },
      t.label
    );
    tabUl.appendChild(el("li", {}, [link]));
  }
  tabBar.appendChild(tabUl);
  container.appendChild(tabBar);

  const body = el("section", { id: "tab-body" });
  container.appendChild(body);

  if (tabId === "overview") return renderOverviewTab(body, a);
  if (tabId === "conversation") return renderConversationTab(body, a);
  if (tabId === "memory") return renderMemoryTab(body, a);
  if (tabId === "journal") return renderJournalTab(body, a);
  if (tabId === "facts") return renderFactsTab(body, a);
  if (tabId === "manage") return renderManageTab(body, a);
}

async function renderOverviewTab(body, a) {
  body.innerHTML = "";
  body.appendChild(el("article", { "aria-busy": "true" }, "加载…"));
  const [convResp, journalResp] = await Promise.all([
    api.get("/api/browse/conversations", { assistantId: a.assistantId, limit: 3 }),
    api.get("/api/browse/journal", { assistantId: a.assistantId, limit: 3 }),
  ]);
  body.innerHTML = "";

  const profile = el("article", {}, [
    el("header", {}, [el("strong", {}, "Profile")]),
    el("dl", { class: "config-dl" }, [
      el("dt", {}, "characterName"),
      el("dd", {}, a.characterName || ""),
      el("dt", {}, "characterBackground"),
      el("dd", { class: "wrap-pre" }, a.characterBackground || "(空)"),
      el("dt", {}, "lastSessionId"),
      el("dd", { class: "mono" }, a.lastSessionId || "—"),
      el("dt", {}, "lastProactiveCheckAt"),
      el("dd", {}, formatTime(a.lastProactiveCheckAt)),
      el("dt", {}, "createdAt / updatedAt"),
      el("dd", {}, `${formatTime(a.createdAt)} / ${formatTime(a.updatedAt)}`),
    ]),
  ]);
  body.appendChild(profile);

  const stateBlock = el("article", {}, [
    el("header", {}, [el("strong", {}, "State")]),
    el("dl", { class: "config-dl" }, [
      el("dt", {}, "familiarity"),
      el("dd", {}, String(a.state?.familiarity ?? 0)),
      el("dt", {}, "totalTurns"),
      el("dd", {}, String(a.state?.totalTurns ?? 0)),
      el("dt", {}, "activeSessionId"),
      el("dd", { class: "mono" }, a.state?.activeSessionId || "—"),
      el("dt", {}, "lastUserMessageAt"),
      el("dd", {}, formatTime(a.state?.lastUserMessageAt)),
      el("dt", {}, "lastProactiveAt"),
      el("dd", {}, formatTime(a.state?.lastProactiveAt)),
    ]),
  ]);
  body.appendChild(stateBlock);

  const recentTurnsBlock = el("article", {}, [
    el("header", {}, [el("strong", {}, "最近 3 条对话")]),
  ]);
  if (!convResp.items.length) {
    recentTurnsBlock.appendChild(el("p", { class: "muted" }, "暂无"));
  } else {
    for (const t of convResp.items) {
      recentTurnsBlock.appendChild(
        el("div", { class: `turn turn--${t.role}` }, [
          el("div", { class: "turn-meta" }, [
            el("strong", {}, t.role),
            " ",
            el("small", {}, formatTime(t.createdAt)),
          ]),
          el("div", { class: "turn-body" }, t.content),
        ])
      );
    }
  }
  body.appendChild(recentTurnsBlock);

  const recentJournalBlock = el("article", {}, [
    el("header", {}, [el("strong", {}, "最近 3 条行为日志")]),
  ]);
  if (!journalResp.items.length) {
    recentJournalBlock.appendChild(el("p", { class: "muted" }, "暂无"));
  } else {
    for (const j of journalResp.items) {
      recentJournalBlock.appendChild(
        el("div", { class: "journal-mini" }, [
          el("div", {}, [
            el("strong", {}, j.runType),
            " ",
            el("small", { class: "muted" }, formatTime(j.createdAt)),
            " ",
            el("span", { class: `pill pill--${j.status}` }, j.status),
          ]),
          j.messageIntent
            ? el("div", { class: "muted" }, `intent: ${j.messageIntent}`)
            : null,
          j.reason ? el("div", {}, `reason: ${shortText(j.reason, 200)}`) : null,
        ])
      );
    }
  }
  body.appendChild(recentJournalBlock);
}

async function renderConversationTab(body, a) {
  body.innerHTML = "";
  const sessionResp = await api.get("/api/browse/sessions", { assistantId: a.assistantId });
  const sessions = sessionResp.sessions || [];

  const layout = el("div", { class: "conv-layout" });
  const left = el("aside", { class: "conv-sessions" });
  const right = el("section", { class: "conv-stream" });
  layout.appendChild(left);
  layout.appendChild(right);
  body.appendChild(layout);

  left.appendChild(el("h4", {}, "Sessions"));
  if (!sessions.length) {
    left.appendChild(el("p", { class: "muted" }, "无 session"));
  }

  const sessionState = { active: sessions[0]?.sessionId || null };
  const sessionLinks = [];
  for (const s of sessions) {
    const item = el(
      "a",
      {
        href: "#",
        class: `session-item ${s.sessionId === sessionState.active ? "session-item--active" : ""}`,
        onclick: (ev) => {
          ev.preventDefault();
          sessionState.active = s.sessionId;
          for (const l of sessionLinks) l.classList.remove("session-item--active");
          item.classList.add("session-item--active");
          loadStream();
        },
      },
      [
        el("div", { class: "mono small-mono" }, s.sessionId),
        el(
          "small",
          { class: "muted" },
          `${s.turnCount} 轮 / ${formatTime(s.lastAt)}`
        ),
      ]
    );
    sessionLinks.push(item);
    left.appendChild(item);
  }

  let oldestCreatedAt = null;
  let nextBefore = null;

  async function loadStream(append = false) {
    if (!append) {
      right.innerHTML = "";
      oldestCreatedAt = null;
      nextBefore = null;
    }
    if (!sessionState.active) {
      right.appendChild(el("p", { class: "muted" }, "选择一个 session"));
      return;
    }
    const params = {
      assistantId: a.assistantId,
      sessionId: sessionState.active,
      limit: 100,
    };
    if (append && oldestCreatedAt) params.before = oldestCreatedAt;
    const resp = await api.get("/api/browse/conversations", params);
    const items = resp.items.slice().reverse();
    for (const t of items) {
      const bubble = el("div", { class: `bubble bubble--${t.role}` }, [
        el("div", { class: "bubble-meta" }, [
          el("strong", {}, t.role),
          " ",
          el("small", { class: "muted" }, formatTime(t.createdAt)),
        ]),
        el("div", { class: "bubble-content" }, t.content),
      ]);
      if (append) right.insertBefore(bubble, right.firstChild);
      else right.appendChild(bubble);
    }
    if (resp.items.length) {
      oldestCreatedAt = resp.items[resp.items.length - 1].createdAt;
    }
    nextBefore = resp.nextBefore;
    const oldBtn = right.querySelector(".load-older-btn");
    if (oldBtn) oldBtn.remove();
    if (nextBefore) {
      const btn = el(
        "button",
        {
          class: "outline load-older-btn",
          onclick: () => loadStream(true),
        },
        "加载更早"
      );
      right.insertBefore(btn, right.firstChild);
    }
  }

  await loadStream();
}

async function renderMemoryTab(body, a) {
  body.innerHTML = "";
  const filterRow = el("div", { class: "filter-row" });
  const sel = el("select", { id: "memory-type" });
  for (const opt of [
    { value: "all", text: "全部" },
    { value: "user_turn", text: "user_turn" },
    { value: "assistant_turn", text: "assistant_turn" },
    { value: "life_event", text: "life_event" },
    { value: "work_event", text: "work_event" },
    { value: "turn", text: "turn (legacy)" },
  ]) {
    sel.appendChild(el("option", { value: opt.value }, opt.text));
  }
  filterRow.appendChild(el("label", {}, ["类型 ", sel]));
  body.appendChild(filterRow);
  const tableWrap = el("div", { class: "table-wrap" });
  body.appendChild(tableWrap);
  const moreWrap = el("div", { class: "more-wrap" });
  body.appendChild(moreWrap);

  let nextBefore = null;
  let lastType = "all";

  function buildHeader() {
    const t = el("table");
    t.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, "时间"),
          el("th", {}, "type"),
          el("th", {}, "content"),
          el("th", {}, "salience"),
          el("th", {}, "confidence"),
          el("th", {}, "vec"),
        ]),
      ])
    );
    t.appendChild(el("tbody", { id: "memory-tbody" }));
    return t;
  }

  async function load(reset = true) {
    if (reset) {
      tableWrap.innerHTML = "";
      tableWrap.appendChild(buildHeader());
      nextBefore = null;
    }
    const params = { assistantId: a.assistantId, limit: 100 };
    if (lastType !== "all") params.type = lastType;
    if (!reset && nextBefore) params.before = nextBefore;
    const resp = await api.get("/api/browse/memories", params);
    const tbody = document.getElementById("memory-tbody");
    for (const m of resp.items) {
      tbody.appendChild(
        el("tr", {}, [
          el("td", { class: "td-time" }, formatTime(m.createdAt)),
          el("td", {}, m.memoryType),
          el("td", { class: "td-content", title: m.content }, shortText(m.content, 120)),
          el("td", {}, (m.salience ?? 0).toFixed(2)),
          el("td", {}, (m.confidence ?? 0).toFixed(2)),
          el("td", {}, m.vectorStatus || ""),
        ])
      );
    }
    nextBefore = resp.nextBefore;
    moreWrap.innerHTML = "";
    if (nextBefore) {
      moreWrap.appendChild(
        el("button", { class: "outline", onclick: () => load(false) }, "加载更早")
      );
    }
  }

  sel.addEventListener("change", () => {
    lastType = sel.value;
    load(true);
  });
  await load(true);
}

async function renderJournalTab(body, a) {
  body.innerHTML = "";
  const filter = el("div", { class: "journal-filter grid" }, [
    (() => {
      const s = el("select", { id: "j-runtype" });
      for (const opt of [
        { value: "all", text: "全部 runType" },
        { value: "life_tick", text: "life_tick" },
        { value: "proactive_message_tick", text: "proactive_message_tick" },
        { value: "initiate_tick", text: "initiate_tick" },
      ]) {
        s.appendChild(el("option", { value: opt.value }, opt.text));
      }
      return el("label", {}, ["runType", s]);
    })(),
    el("label", {}, [
      "from",
      el("input", { type: "datetime-local", id: "j-from" }),
    ]),
    el("label", {}, [
      "to",
      el("input", { type: "datetime-local", id: "j-to" }),
    ]),
    el("label", { class: "filter-apply" }, [
      el("span", {}, " "),
      el(
        "button",
        {
          onclick: () => load(true),
        },
        "应用筛选"
      ),
    ]),
  ]);
  body.appendChild(filter);

  const tableWrap = el("div", { class: "table-wrap" });
  body.appendChild(tableWrap);
  const moreWrap = el("div", { class: "more-wrap" });
  body.appendChild(moreWrap);

  let nextBefore = null;

  function buildHeader() {
    const t = el("table", { class: "journal-table" });
    t.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, "时间"),
          el("th", {}, "runType"),
          el("th", {}, "status"),
          el("th", {}, "persist"),
          el("th", {}, "initiate"),
          el("th", {}, "intent"),
          el("th", {}, "draft"),
          el("th", {}, "reason"),
        ]),
      ])
    );
    t.appendChild(el("tbody", { id: "journal-tbody" }));
    return t;
  }

  function dtToMs(value) {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.getTime();
  }

  async function load(reset = true) {
    if (reset) {
      tableWrap.innerHTML = "";
      tableWrap.appendChild(buildHeader());
      nextBefore = null;
    }
    const runType = document.getElementById("j-runtype").value;
    const from = dtToMs(document.getElementById("j-from").value);
    const to = dtToMs(document.getElementById("j-to").value);
    const params = {
      assistantId: a.assistantId,
      limit: 100,
    };
    if (runType !== "all") params.runType = runType;
    if (from !== undefined) params.from = from;
    if (to !== undefined) params.to = to;
    if (!reset && nextBefore) params.before = nextBefore;
    const resp = await api.get("/api/browse/journal", params);
    const tbody = document.getElementById("journal-tbody");
    for (const j of resp.items) {
      const cls = [];
      if (j.shouldPersist === true) cls.push("row-persist");
      if (j.shouldInitiate === true) cls.push("row-initiate");
      if (j.status === "error") cls.push("row-error");
      const row = el("tr", { class: cls.join(" ") }, [
        el("td", { class: "td-time" }, formatTime(j.createdAt)),
        el("td", {}, j.runType),
        el("td", {}, el("span", { class: `pill pill--${j.status}` }, j.status)),
        el("td", {}, renderTri(j.shouldPersist)),
        el("td", {}, renderTri(j.shouldInitiate)),
        el("td", {}, j.messageIntent || ""),
        el(
          "td",
          { class: "td-content" },
          j.draftMessage
            ? el(
                "details",
                {},
                [
                  el("summary", {}, shortText(j.draftMessage, 40) || "(空)"),
                  el("div", { class: "wrap-pre" }, j.draftMessage),
                ]
              )
            : ""
        ),
        el(
          "td",
          { class: "td-content" },
          j.errorMessage
            ? el("span", { class: "txt-error", title: j.errorMessage }, shortText(j.errorMessage, 60))
            : shortText(j.reason, 100)
        ),
      ]);
      tbody.appendChild(row);
    }
    nextBefore = resp.nextBefore;
    moreWrap.innerHTML = "";
    if (nextBefore) {
      moreWrap.appendChild(
        el("button", { class: "outline", onclick: () => load(false) }, "加载更早")
      );
    }
  }

  function renderTri(value) {
    if (value === null || value === undefined) return el("span", { class: "muted" }, "—");
    return el("span", { class: value ? "pill pill--ok" : "pill pill--off" }, value ? "yes" : "no");
  }

  await load(true);
}

async function renderFactsTab(body, a) {
  body.innerHTML = "";
  const resp = await api.get("/api/browse/facts", { assistantId: a.assistantId, limit: 200 });
  const items = resp.items || [];
  if (!items.length) {
    body.appendChild(el("article", {}, "暂无事实。"));
    return;
  }
  const t = el("table", {}, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "时间"),
        el("th", {}, "key"),
        el("th", {}, "value"),
        el("th", {}, "confidence"),
      ]),
    ]),
  ]);
  const tbody = el("tbody");
  for (const f of items) {
    tbody.appendChild(
      el("tr", {}, [
        el("td", { class: "td-time" }, formatTime(f.createdAt)),
        el("td", { class: "mono" }, f.factKey),
        el("td", { class: "td-content", title: f.factValue }, shortText(f.factValue, 200)),
        el("td", {}, (f.confidence ?? 0).toFixed(2)),
      ])
    );
  }
  t.appendChild(tbody);
  body.appendChild(el("div", { class: "table-wrap" }, [t]));
}

async function renderManageTab(body, a) {
  body.innerHTML = "";

  const togglesArticle = el("article", {}, [
    el("header", {}, [el("strong", {}, "自驱开关")]),
    el("p", { class: "muted" }, "切换后立即生效。下次 cron tick 或手动触发会读取最新值。"),
    el("div", { class: "switch-row" }, [
      el("label", {}, [
        el("input", {
          type: "checkbox",
          role: "switch",
          id: "tg-autolife",
          checked: a.allowAutoLife ? "checked" : false,
        }),
        " 自驱生活记忆 (allow_auto_life)",
      ]),
    ]),
    el("div", { class: "switch-row" }, [
      el("label", {}, [
        el("input", {
          type: "checkbox",
          role: "switch",
          id: "tg-proactive",
          checked: a.allowProactiveMessage ? "checked" : false,
        }),
        " 主动消息 (allow_proactive_message)",
      ]),
    ]),
  ]);
  body.appendChild(togglesArticle);

  const tgLife = document.getElementById("tg-autolife");
  const tgPro = document.getElementById("tg-proactive");

  async function patchFlags(flags) {
    try {
      const resp = await api.patch(
        `/api/browse/assistants/${encodeURIComponent(a.assistantId)}/flags`,
        flags
      );
      a.allowAutoLife = resp.profile.allowAutoLife;
      a.allowProactiveMessage = resp.profile.allowProactiveMessage;
      const target = Object.keys(flags)[0];
      const newVal = flags[target];
      showToast(`${target} = ${newVal}`, "ok");
    } catch (err) {
      showToast(`保存失败: ${err.message}`, "err");
      if ("allowAutoLife" in flags) tgLife.checked = a.allowAutoLife;
      if ("allowProactiveMessage" in flags) tgPro.checked = a.allowProactiveMessage;
    }
  }

  tgLife.addEventListener("change", () => patchFlags({ allowAutoLife: tgLife.checked }));
  tgPro.addEventListener("change", () =>
    patchFlags({ allowProactiveMessage: tgPro.checked })
  );

  const profileForm = el("article", {}, [
    el("header", {}, [el("strong", {}, "Profile 编辑")]),
    el("label", {}, [
      "characterName",
      el("input", { id: "edit-name", value: a.characterName || "" }),
    ]),
    el("label", {}, [
      "characterBackground",
      el("textarea", { id: "edit-bg", rows: "6" }, a.characterBackground || ""),
    ]),
    el(
      "button",
      {
        onclick: async (ev) => {
          ev.preventDefault();
          const name = document.getElementById("edit-name").value.trim();
          const bg = document.getElementById("edit-bg").value;
          try {
            const resp = await api.patch(
              `/api/browse/assistants/${encodeURIComponent(a.assistantId)}/profile`,
              { characterName: name || undefined, characterBackground: bg }
            );
            a.characterName = resp.profile.characterName;
            a.characterBackground = resp.profile.characterBackground;
            showToast("已保存", "ok");
          } catch (err) {
            showToast(`保存失败: ${err.message}`, "err");
          }
        },
      },
      "保存 Profile"
    ),
  ]);
  body.appendChild(profileForm);

  const runArea = el("article", {}, [
    el("header", {}, [el("strong", {}, "手动触发")]),
    el(
      "p",
      { class: "muted" },
      "手动调用 scheduler 当前角色的 life / proactive_message tick。dryRun=false 会真正写入记忆并可能触发推送。"
    ),
    buildRunRow("life", "立即跑一次 life 决策", a),
    buildRunRow("message", "立即生成一条 proactive 消息", a),
    el("h5", {}, "结果"),
    el("pre", { id: "run-output" }, "—"),
  ]);
  body.appendChild(runArea);
}

function buildRunRow(job, label, a) {
  const dryId = `dry-${job}`;
  const btn = el(
    "button",
    {
      class: "outline run-btn",
      onclick: async (ev) => {
        ev.preventDefault();
        const dryRun = document.getElementById(dryId).checked;
        if (!dryRun) {
          if (
            !confirm(
              "确定要 dryRun=false 跑一次？将真实写入记忆/可能触发推送。"
            )
          ) {
            return;
          }
        }
        const out = document.getElementById("run-output");
        out.textContent = "running…";
        btn.setAttribute("aria-busy", "true");
        try {
          const resp = await api.post(
            `/api/browse/assistants/${encodeURIComponent(a.assistantId)}/run`,
            { job, dryRun }
          );
          out.textContent = JSON.stringify(resp, null, 2);
          showToast(`${job} ${dryRun ? "(dryRun)" : ""} 完成`, "ok");
        } catch (err) {
          out.textContent = `error: ${err.message}\n${JSON.stringify(err.payload || {}, null, 2)}`;
          showToast(`${job} 失败`, "err");
        } finally {
          btn.removeAttribute("aria-busy");
        }
      },
    },
    label
  );
  return el("div", { class: "run-row" }, [
    btn,
    el("label", { class: "run-dry" }, [
      el("input", { type: "checkbox", id: dryId, checked: "checked" }),
      " dryRun（默认勾选）",
    ]),
  ]);
}

function parseHash() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) return { route: "home" };
  if (parts[0] === "search") return { route: "search" };
  if (parts[0] === "character" && parts[1]) {
    return {
      route: "character",
      assistantId: decodeURIComponent(parts[1]),
      tab: parts[2] || "overview",
    };
  }
  return { route: "home" };
}

function dispatch() {
  const r = parseHash();
  if (r.route === "home") return viewHome();
  if (r.route === "search") return viewSearch();
  if (r.route === "character") return viewCharacter(r.assistantId, r.tab);
  return viewHome();
}

window.addEventListener("hashchange", dispatch);
window.addEventListener("DOMContentLoaded", () => {
  startHealthPing();
  dispatch();
});
