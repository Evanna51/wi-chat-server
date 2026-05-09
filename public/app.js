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
  del: (path) => request("DELETE", path, {}),
};

/**
 * assistant_type 语义（与 chatbox-Android `MyAssistant.type` 对齐）：
 *   "character" 人物型陪伴角色 — 显示自驱生活 / 主动消息开关
 *   "writer"    写作助手        — 隐藏自驱开关
 *   "default"   通用助手        — 隐藏自驱开关
 *   ""          老数据未携带 type — 沿用 character 行为（向后兼容）
 *   其它        视作非陪伴型      — 隐藏自驱开关
 */
function isCharacterTypeLike(type) {
  if (!type) return true; // 向后兼容：空 type 当 character
  return type === "character";
}

function assistantTypeLabel(type) {
  switch (type) {
    case "character":
      return "人物";
    case "writer":
      return "作家";
    case "default":
      return "通用";
    case "":
    case undefined:
    case null:
      return "未指定";
    default:
      return type;
  }
}

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

/**
 * 行内删除按钮：物理删（不可恢复），点击 → confirm → DELETE → 移除该行 / 触发 onSuccess。
 * @param {string} url     DELETE 目标
 * @param {string} confirmMsg
 * @param {function} onDeleted  删除成功回调（用于移除行 / 刷新视图）
 */
function rowDeleteBtn(url, _legacyMsg, onDeleted) {
  // 直接删，不二次确认（按 Evanna 要求）。误删可从 sqlite 备份恢复。
  return el(
    "button",
    {
      class: "row-del-btn",
      title: "物理删除（不可恢复）",
      onclick: async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const btn = ev.currentTarget;
        btn.setAttribute("aria-busy", "true");
        try {
          await api.del(url);
          showToast("已删除", "success");
          onDeleted?.();
        } catch (err) {
          const detail = err.payload?.error || err.message || "unknown";
          const status = err.status ? ` [${err.status}]` : "";
          console.error("[row-del] DELETE", url, "→", err.payload || err);
          showToast(`删除失败${status}: ${detail}`, "error");
        } finally {
          btn.removeAttribute("aria-busy");
        }
      },
    },
    "删除"
  );
}

// ─── 中文翻译表（identityVocab 一一对应）───────────────────────────────
// 服务端 vocab 是英文 enum，UI 里展示中文释义但保存值仍是英文 key。
const ZH = {
  attachmentStyle: {
    secure: "安全型",
    anxious: "焦虑型",
    avoidant: "回避型",
    disorganized: "混乱型",
  },
  socialStrategy: {
    casual: "日常闲聊",
    defensive: "自我保护",
    intimate: "亲密袒露",
    philosophical: "抽象探讨",
    depressive: "低落退缩",
    teasing: "戏谑调侃",
    detached: "主动疏离",
    caretaker: "照顾对方",
    inquisitive: "好奇追问",
    ritualistic: "仪式感",
    confessional: "主动倾诉",
    reassuring: "安抚信任",
  },
  trait: {
    secure_attachment: "安全依恋", anxious_attachment: "焦虑依恋",
    avoidant_attachment: "回避依恋", disorganized_attachment: "混乱依恋",
    rational_suppressive: "理性压抑情绪", emotionally_expressive: "情绪外放",
    melancholic: "易陷低落", even_keeled: "情绪平稳", volatile: "起伏剧烈",
    high_sensitivity: "高度敏感", low_sensitivity: "低敏感",
    thin_skinned: "易受伤", thick_skinned: "不易受伤",
    people_pleasing: "讨好倾向", defensive_aloof: "防御性疏离",
    controlling: "控制欲", submissive: "顺从",
    playful_teasing: "嬉戏调侃", withdrawn: "退缩",
    high_empathy: "高共情", low_empathy: "低共情",
    selective_empathy: "选择性共情",
    easily_jealous: "易嫉妒", possessive: "占有欲", non_possessive: "不占有",
    perfectionist: "完美主义", self_critical: "自我批判",
    self_accepting: "自我接纳", self_aggrandizing: "自我膨胀",
    romantic_idealist: "浪漫理想化", cynical_realist: "愤世现实",
    intellectually_romantic: "智性浪漫",
    verbose: "话多", taciturn: "寡言", eloquent: "善表达",
  },
  careLanguage: {
    verbal_affirmation: "言语肯定",
    quality_time: "共度时光",
    acts_of_service: "实际行动 / 帮做事",
    gifts: "礼物心意",
    physical_proximity: "身体亲近",
  },
  tension: {
    intimacy_vs_independence: "亲密 vs 独立",
    rationality_vs_emotion: "理性 vs 情感",
    sincerity_vs_self_protection: "真诚 vs 自我保护",
    attachment_vs_fear: "依附 vs 恐惧",
    stability_vs_novelty: "稳定 vs 新鲜",
    control_vs_surrender: "掌控 vs 交付",
    idealism_vs_pragmatism: "理想 vs 现实",
    vulnerability_vs_pride: "示弱 vs 自尊",
  },
  insecurity: {
    fear_of_abandonment: "害怕被抛弃",
    fear_of_being_boring: "害怕无趣",
    fear_of_being_replaced: "害怕被取代",
    fear_of_intimacy: "害怕亲密",
    fear_of_judgment: "害怕被评判",
    fear_of_inadequacy: "害怕不够好",
    fear_of_losing_independence: "害怕失去独立",
    fear_of_being_misunderstood: "害怕被误解",
    fear_of_rejection: "害怕被拒绝",
    fear_of_being_too_much: "害怕自己'太多了'",
    fear_of_failure: "害怕失败",
    fear_of_being_used: "害怕被利用",
    fear_of_loss: "害怕失去",
    fear_of_change: "害怕改变",
    fear_of_loneliness: "害怕孤独",
    fear_of_being_seen: "害怕被真正看见",
    fear_of_commitment: "害怕承诺",
    fear_of_vulnerability: "害怕脆弱",
    fear_of_disappointing_others: "害怕让人失望",
    fear_of_aging: "害怕衰老",
  },
  wound: {
    childhood_neglect: "童年忽视",
    betrayal_trauma: "背叛创伤",
    performance_conditional_love: "表现换爱",
    abandonment_history: "被抛弃史",
    emotional_invalidation: "情绪不被允许",
    loss_of_caregiver: "失去照护者",
    chronic_loneliness: "长期孤独",
    parental_enmeshment: "与父母过度纠缠",
    bullying_history: "霸凌经历",
    body_shame: "身体羞辱",
    chronic_invalidation: "长期不被认可",
    divorce_of_parents: "父母离异",
    early_loss: "早年重大丧失",
    caretaker_role_too_young: "过早承担照护者",
    emotional_incest: "情感越界",
    public_humiliation: "公开羞辱",
    religious_or_cultural_trauma: "宗教 / 文化创伤",
  },
  dynamicDim: {
    trust: "信任",
    dependency: "依赖",
    emotionalSafety: "情感安全感",
    attachment: "依恋",
    tension: "紧张",
    unresolvedConflict: "未化解冲突",
    abandonmentFear: "被抛弃恐惧",
    reciprocityBalance: "投入对等度",
    emotionalCloseness: "情感亲近",
    socialDistance: "社交距离",
    resentment: "怨恨",
    gratitude: "感激",
  },
  intent: {
    reassure_after_conflict: "冲突后安抚",
    reassure_abandonment_fear: "安抚被抛弃恐惧",
    pursue_reflection_opportunity: "把握反思机会",
    reciprocate_vulnerable_share: "回应袒露",
    follow_up_unresolved_topic: "回看未化解话题",
    confess_suppressed_feeling: "坦白被压抑的情绪",
    reciprocate_gratitude: "回应感激",
    share_topic_progress: "分享话题进展",
    ritual_check_in: "仪式感问候",
    inquisitive_followup: "好奇追问",
    playful_check_in: "玩耍式问候",
    philosophical_invite: "哲思邀请",
    life_check_in: "日常问候",
    none: "不发",
  },
  desire: {
    to_be_understood: "被理解",
    to_be_chosen: "被选中",
    long_term_companionship: "长期陪伴",
    intellectual_partnership: "智识相伴",
    playful_connection: "玩耍式连接",
    safe_to_be_weak: "可以脆弱的安全",
    to_matter_to_someone: "对某人重要",
    freedom_to_be_oneself: "做自己的自由",
    to_be_seen_fully: "完全被看见",
    to_be_held: "被怀抱 / 物理安抚",
    to_belong: "归属感",
    creative_freedom: "创作自由",
    adventure_and_growth: "冒险与成长",
    domestic_intimacy: "日常的亲密",
    to_be_someones_safe_person: "做某人的安全角落",
    to_be_proud_of_oneself: "为自己骄傲",
    aesthetic_immersion: "沉浸式审美",
    mutual_growth: "彼此成长",
  },
};
function zhOf(map, key) {
  return ZH[map]?.[key] || "";
}

// ─── 自定义 select（vis-combo）───────────────────────────────────────
// 替代原生 <select>：可控 option 高度、可显示中文释义。返回 {root, getValue, setValue}。
function makeCombo({ value, options, placeholder = "(unset)", onChange }) {
  // options: [{ value, label, zh? }]
  const root = document.createElement("div");
  root.className = "vis-combo";
  let current = value || "";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "vis-combo__trigger";
  const panel = document.createElement("div");
  panel.className = "vis-combo__panel";
  panel.hidden = true;
  root.appendChild(trigger);
  root.appendChild(panel);

  function renderTrigger() {
    if (!current) {
      trigger.innerHTML = `<span class="vis-combo__placeholder">${placeholder}</span>`;
      return;
    }
    const opt = options.find((o) => o.value === current);
    if (!opt) {
      trigger.textContent = current;
      return;
    }
    trigger.innerHTML = "";
    const v = document.createElement("span");
    v.className = "vis-combo__val";
    v.textContent = opt.value;
    const z = document.createElement("span");
    z.className = "vis-combo__zh";
    z.textContent = opt.zh || "";
    trigger.appendChild(v);
    if (opt.zh) trigger.appendChild(z);
  }
  function renderPanel() {
    panel.innerHTML = "";
    // unset / 占位也算一个选项
    const unsetItem = document.createElement("div");
    unsetItem.className = "vis-combo__opt" + (!current ? " is-active" : "");
    unsetItem.dataset.val = "";
    unsetItem.textContent = placeholder;
    panel.appendChild(unsetItem);

    for (const o of options) {
      const item = document.createElement("div");
      item.className = "vis-combo__opt" + (o.value === current ? " is-active" : "");
      item.dataset.val = o.value;
      const v = document.createElement("span");
      v.className = "vis-combo__val";
      v.textContent = o.value;
      item.appendChild(v);
      if (o.zh) {
        const z = document.createElement("span");
        z.className = "vis-combo__zh";
        z.textContent = o.zh;
        item.appendChild(z);
      }
      panel.appendChild(item);
    }
  }
  function close() {
    panel.hidden = true;
    root.classList.remove("is-open");
  }
  function open() {
    closeAllCombos(root);
    panel.hidden = false;
    root.classList.add("is-open");
  }
  trigger.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (panel.hidden) open();
    else close();
  });
  panel.addEventListener("click", (ev) => {
    const item = ev.target.closest(".vis-combo__opt");
    if (!item) return;
    current = item.dataset.val;
    renderTrigger();
    renderPanel();
    close();
    onChange?.(current);
  });

  renderTrigger();
  renderPanel();

  return {
    root,
    getValue: () => current,
    setValue: (v) => { current = v || ""; renderTrigger(); renderPanel(); },
  };
}
// 全局：点击其它地方关闭所有 open combo
function closeAllCombos(except) {
  document.querySelectorAll(".vis-combo.is-open").forEach((c) => {
    if (c !== except) {
      c.classList.remove("is-open");
      c.querySelector(".vis-combo__panel").hidden = true;
    }
  });
}
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".vis-combo")) closeAllCombos(null);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeAllCombos(null);
});

// ─── 多标签输入（vis-tags）─────────────────────────────────────────
// 已选 tag 一行 + 输入框（Enter 或 ; 触发添加）+ 推荐项一行（点击加进去）。
// API: makeTagsInput({ values, suggestions, suggestionsZhMap, onChange }) → {root, getValues}
function makeTagsInput({ values = [], suggestions = [], suggestionsZhMap = null, allowCustom = true }) {
  const root = document.createElement("div");
  root.className = "vis-tags";
  const list = document.createElement("div");
  list.className = "vis-tags__list";
  const input = document.createElement("input");
  input.className = "vis-tags__input";
  input.type = "text";
  input.placeholder = allowCustom ? "输入自定义内容，按 ; 或 Enter 添加" : "点击下方推荐项添加";
  list.appendChild(input);
  root.appendChild(list);

  // 推荐项区：默认折叠，点开显示。用 <details> 自带的展开/收起。
  const suggestRow = document.createElement("div");
  suggestRow.className = "vis-tags__suggest";
  let suggestWrap = null;
  if (suggestions.length) {
    suggestWrap = document.createElement("details");
    suggestWrap.className = "vis-tags__suggest-wrap";
    const sum = document.createElement("summary");
    sum.className = "vis-tags__suggest-summary";
    sum.textContent = `推荐 ${suggestions.length} 项（点击展开）`;
    suggestWrap.appendChild(sum);
    for (const s of suggestions) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "vis-tags__suggest-chip";
      chip.dataset.val = s;
      const zh = suggestionsZhMap?.[s];
      chip.innerHTML = zh ? `${s}<span class="vis-tags__chip-zh">${zh}</span>` : s;
      suggestRow.appendChild(chip);
    }
    suggestWrap.appendChild(suggestRow);
    root.appendChild(suggestWrap);
  }

  let current = [...values];
  function renderTags() {
    // 清掉已渲染的 tag（保留 input）
    list.querySelectorAll(".vis-tags__tag").forEach((n) => n.remove());
    for (const v of current) {
      const tag = document.createElement("span");
      tag.className = "vis-tags__tag";
      const txt = document.createElement("span");
      txt.textContent = v;
      const zh = suggestionsZhMap?.[v];
      if (zh) {
        const zhSpan = document.createElement("span");
        zhSpan.className = "vis-tags__chip-zh";
        zhSpan.textContent = zh;
        tag.appendChild(txt);
        tag.appendChild(zhSpan);
      } else {
        tag.appendChild(txt);
      }
      const x = document.createElement("button");
      x.type = "button";
      x.className = "vis-tags__remove";
      x.textContent = "×";
      x.title = "移除";
      x.dataset.val = v;
      tag.appendChild(x);
      list.insertBefore(tag, input);
    }
    // 已选过的推荐项：高亮
    suggestRow.querySelectorAll(".vis-tags__suggest-chip").forEach((c) => {
      c.classList.toggle("is-picked", current.includes(c.dataset.val));
    });
  }
  function add(v) {
    const trimmed = String(v || "").trim().replace(/[;；]+$/, "").trim();
    if (!trimmed) return;
    if (current.includes(trimmed)) return;
    current.push(trimmed);
    renderTags();
  }
  function remove(v) {
    current = current.filter((x) => x !== v);
    renderTags();
  }
  // input: Enter / ; / ；触发提交
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === ";" || ev.key === "；") {
      ev.preventDefault();
      add(input.value);
      input.value = "";
    } else if (ev.key === "Backspace" && !input.value && current.length) {
      // 空输入框 + Backspace → 删最后一个
      current.pop();
      renderTags();
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) {
      add(input.value);
      input.value = "";
    }
  });
  list.addEventListener("click", (ev) => {
    const x = ev.target.closest(".vis-tags__remove");
    if (x) remove(x.dataset.val);
  });
  suggestRow.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".vis-tags__suggest-chip");
    if (chip) add(chip.dataset.val);
  });

  renderTags();
  return {
    root,
    getValues: () => [...current],
  };
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

  const wsMap = stats.wsActiveSockets || {};
  const wsEntries = Object.entries(wsMap);
  const wsRowChildren = wsEntries.length
    ? wsEntries.map(([uid, n]) =>
        el("span", { class: "badge badge--neutral" }, `${uid}: ${n}`)
      )
    : [el("span", { class: "muted" }, "(none)")];
  const wsBlock = el("article", {}, [
    el("header", {}, [el("strong", {}, "WS 在线设备数")]),
    el("div", { class: "badge-row" }, wsRowChildren),
  ]);
  container.appendChild(wsBlock);

  const list = assistantsResp.assistants || [];
  const grid = el("section", { class: "card-grid" });
  if (!list.length) {
    grid.appendChild(el("article", {}, "暂无角色，调用 /api/assistant-profile/upsert 创建一个再回来。"));
  }
  for (const a of list) {
    const cardIsChar = isCharacterTypeLike(a.assistantType);

    // 头部：name + id + ghost tags（类型 / 熟悉度，所有 type 都有）
    const ghostTags = el("div", { class: "ghost-tag-row" }, [
      el("span", { class: "ghost-tag", title: "assistant_type" },
        `类型 · ${assistantTypeLabel(a.assistantType)}`),
      el("span", { class: "ghost-tag", title: "familiarity" },
        `熟悉度 · ${a.state?.familiarity ?? 0}/100`),
    ]);

    // 中部：自驱开关（仅 character 类型）—— 非 character 时这区域占位以保持高度
    const togglesRow = cardIsChar
      ? el("div", { class: "card-toggles" }, [
          el("span", {
            class: `badge ${a.allowAutoLife ? "badge--on" : "badge--off"}`,
            title: "allow_auto_life",
          }, `自驱生活: ${a.allowAutoLife ? "on" : "off"}`),
          el("span", {
            class: `badge ${a.allowProactiveMessage ? "badge--on" : "badge--off"}`,
            title: "allow_proactive_message",
          }, `主动消息: ${a.allowProactiveMessage ? "on" : "off"}`),
        ])
      : el("div", { class: "card-toggles card-toggles--placeholder" },
          el("span", { class: "muted small" }, "（非人物类型，无自驱配置）"));

    const card = el("article", { class: "char-card" }, [
      el("header", { class: "char-card__head" }, [
        el("strong", { class: "char-card__name" }, a.characterName || a.assistantId),
        el("small", { class: "char-card__id" }, a.assistantId),
        ghostTags,
      ]),
      el("div", { class: "char-card__body" }, [
        togglesRow,
        el("div", { class: "char-card__counts" }, [
          el("span", {}, `对话 ${a.counts.conversationTurns}`),
          el("span", {}, `记忆 ${a.counts.memoryItems}`),
          el("span", {}, `行为 ${a.counts.journalEntries}`),
        ]),
      ]),
      el("footer", { class: "char-card__foot" }, [
        el("a", {
          href: `#/character/${encodeURIComponent(a.assistantId)}`,
          role: "button",
          class: "char-card__enter",
        }, "查看"),
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
            const sel = el("select", { class: "vis-select", id: "search-scope" });
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
  { id: "identity", label: "Identity" },
  { id: "cognition", label: "认知" },
  { id: "intent", label: "意图" },
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

  const isCharacterLike = isCharacterTypeLike(a.assistantType);
  const badges = [];
  badges.push(el("span", { class: "badge badge--neutral" }, `类型: ${assistantTypeLabel(a.assistantType)}`));
  if (isCharacterLike) {
    badges.push(
      el(
        "span",
        { class: `badge ${a.allowAutoLife ? "badge--on" : "badge--off"}` },
        `自驱生活: ${a.allowAutoLife ? "on" : "off"}`
      )
    );
    badges.push(
      el(
        "span",
        { class: `badge ${a.allowProactiveMessage ? "badge--on" : "badge--off"}` },
        `主动消息: ${a.allowProactiveMessage ? "on" : "off"}`
      )
    );
  }
  badges.push(el("span", { class: "badge badge--neutral" }, `熟悉度: ${a.state?.familiarity ?? 0}/100`));
  badges.push(el("span", { class: "badge badge--neutral" }, `轮次: ${a.state?.totalTurns ?? 0}`));

  const head = el("section", { class: "char-head" }, [
    el("h2", {}, a.characterName || a.assistantId),
    el("small", { class: "muted mono" }, a.assistantId),
    el("div", { class: "badge-row" }, badges),
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
  if (tabId === "identity") return renderIdentityTab(body, a);
  if (tabId === "cognition") return renderCognitionTab(body, a);
  if (tabId === "intent") return renderIntentTab(body, a);
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
      const bubble = el("div", { class: `bubble bubble--${t.role}` });
      const deleteBtn = el(
        "button",
        {
          class: "bubble-delete",
          title: "删除这条对话（含衍生记忆）",
          onclick: async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            // 直接删，不二次确认
            try {
              const r = await api.del(`/api/browse/conversation-turns/${encodeURIComponent(t.id)}`);
              bubble.remove();
              console.log("[delete]", t.id, r.deleted);
            } catch (e) {
              alert(`删除失败：${e.message || e}`);
            }
          },
        },
        "× 删除"
      );
      bubble.appendChild(
        el("div", { class: "bubble-meta" }, [
          el("strong", {}, t.role),
          " ",
          el("small", { class: "muted" }, formatTime(t.createdAt)),
          " ",
          el("small", { class: "muted mono", title: t.id }, t.id.slice(0, 8)),
          deleteBtn,
        ])
      );
      bubble.appendChild(el("div", { class: "bubble-content" }, t.content));
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
  const sel = el("select", { class: "vis-select", id: "memory-type" });
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
  filterRow.appendChild(el("label", { class: "filter-field" }, [
    el("span", { class: "filter-label" }, "type"),
    el("span", { class: "filter-label-zh" }, "类型"),
    sel,
  ]));
  body.appendChild(filterRow);
  const tableWrap = el("div", { class: "table-wrap" });
  body.appendChild(tableWrap);
  const moreWrap = el("div", { class: "more-wrap" });
  body.appendChild(moreWrap);

  let nextBefore = null;
  let lastType = "all";

  function buildHeader() {
    const TH = (en, zh) => el("th", {}, [
      el("div", { class: "th-en" }, en),
      el("div", { class: "th-zh" }, zh),
    ]);
    const t = el("table");
    t.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          TH("time", "时间"),
          TH("type", "类型"),
          TH("content", "内容"),
          TH("salience", "重要度"),
          TH("confidence", "置信度"),
          TH("vec", "向量化"),
          el("th", { class: "th-action" }, ""),
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
      const tr = el("tr", {}, [
        el("td", { class: "td-time" }, formatTime(m.createdAt)),
        el("td", {}, m.memoryType),
        el("td", { class: "td-content", title: m.content }, shortText(m.content, 120)),
        el("td", {}, (m.salience ?? 0).toFixed(2)),
        el("td", {}, (m.confidence ?? 0).toFixed(2)),
        el("td", {}, m.vectorStatus || ""),
        el("td", { class: "td-action" }, rowDeleteBtn(
          `/api/browse/memories/${encodeURIComponent(m.id)}`,
          `删除该条 memory_item？\n\n这会级联删 facts / vectors / edges / source_turn，不可恢复。\n\n${shortText(m.content, 80)}`,
          () => tr.remove(),
        )),
      ]);
      tbody.appendChild(tr);
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

// 行为日志: runType / status 中文映射
const RUN_TYPE_ZH = {
  life_tick: "生活记忆",
  proactive_message_tick: "主动消息评估",
  initiate_tick: "主动发起",
  catchup_tick: "补叙",
  next_push_schedule: "下一条预排",
  plan_generation_tick: "Plan 生成",
  dead_letter_alert: "死信告警",
};
const STATUS_ZH = {
  ok: "正常",
  error: "出错",
  skipped: "跳过",
  cancelled: "取消",
  pending: "待处理",
};

async function renderJournalTab(body, a) {
  body.innerHTML = "";
  const filter = el("div", { class: "journal-filter" }, [
    (() => {
      const s = el("select", { class: "vis-select", id: "j-runtype" });
      for (const opt of [
        { value: "all", text: "全部" },
        { value: "next_push_schedule", text: "next_push_schedule（下一条预排）" },
        { value: "plan_generation_tick", text: "plan_generation_tick（Plan 生成）" },
        { value: "catchup_tick", text: "catchup_tick（补叙）" },
        { value: "life_tick", text: "life_tick（生活记忆）" },
        { value: "proactive_message_tick", text: "proactive_message_tick（主动消息评估）" },
        { value: "initiate_tick", text: "initiate_tick（主动发起）" },
        { value: "dead_letter_alert", text: "dead_letter_alert（死信告警）" },
      ]) {
        s.appendChild(el("option", { value: opt.value }, opt.text));
      }
      return el("label", { class: "filter-field" }, [
        el("span", { class: "filter-label" }, "runType"),
        el("span", { class: "filter-label-zh" }, "事件类型"),
        s,
      ]);
    })(),
    el("label", { class: "filter-field" }, [
      el("span", { class: "filter-label" }, "from"),
      el("span", { class: "filter-label-zh" }, "起始时间"),
      el("input", { class: "vis-input", type: "datetime-local", id: "j-from" }),
    ]),
    el("label", { class: "filter-field" }, [
      el("span", { class: "filter-label" }, "to"),
      el("span", { class: "filter-label-zh" }, "结束时间"),
      el("input", { class: "vis-input", type: "datetime-local", id: "j-to" }),
    ]),
    el("button", { class: "outline filter-apply-btn", onclick: () => load(true) }, "应用筛选"),
  ]);
  body.appendChild(filter);

  const tableWrap = el("div", { class: "table-wrap" });
  body.appendChild(tableWrap);
  const moreWrap = el("div", { class: "more-wrap" });
  body.appendChild(moreWrap);

  let nextBefore = null;

  // 双语表头
  const TH = (en, zh) => el("th", {}, [
    el("div", { class: "th-en" }, en),
    el("div", { class: "th-zh" }, zh),
  ]);

  function buildHeader() {
    const t = el("table", { class: "journal-table" });
    t.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          TH("time", "时间"),
          TH("runType", "事件类型"),
          TH("status", "状态"),
          TH("persist", "落库"),
          TH("initiate", "已发"),
          TH("intent", "意图"),
          TH("draft / reason", "草稿 / 原因"),
          el("th", { class: "th-action" }, ""),
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
      const draftFull = j.draftMessage || "";
      const draftSummary = draftFull
        ? shortText(draftFull, 60)
        : (j.errorMessage ? shortText(j.errorMessage, 60) : (j.reason ? shortText(j.reason, 60) : "—"));
      const reasonShort = draftFull && (j.errorMessage || j.reason)
        ? shortText(j.errorMessage || j.reason, 80)
        : "";

      const row = el("tr", { class: ["journal-row", ...cls].join(" ") }, [
        el("td", { class: "td-time" }, formatTime(j.createdAt)),
        el("td", {}, [
          el("div", { class: "mono small" }, j.runType),
          el("div", { class: "muted small" }, RUN_TYPE_ZH[j.runType] || ""),
        ]),
        el("td", {}, el("span", { class: `pill pill--${j.status}` }, STATUS_ZH[j.status] || j.status)),
        el("td", {}, renderTri(j.shouldPersist)),
        el("td", {}, renderTri(j.shouldInitiate)),
        el("td", { class: "muted small" }, j.messageIntent || "—"),
        el("td", { class: "td-draft" }, [
          el("div", { class: "td-draft__sum" }, draftSummary),
          reasonShort ? el("div", { class: "td-draft__reason" }, reasonShort) : null,
          el("span", { class: "td-draft__expand" }, "▾"),
        ]),
        el("td", { class: "td-action" }, rowDeleteBtn(
          `/api/browse/journal/${encodeURIComponent(j.id)}`,
          "",
          () => { row.remove(); detail.remove(); },
        )),
      ]);

      // 展开行：占满整行宽度，显示完整 draft + reason + error + meta
      const detail = el("tr", { class: "journal-detail", hidden: "hidden" }, [
        el("td", { colspan: 8 }, el("div", { class: "journal-detail__grid" }, [
          draftFull ? el("section", {}, [
            el("h5", {}, "Draft 草稿"),
            el("div", { class: "wrap-pre" }, draftFull),
          ]) : null,
          j.errorMessage ? el("section", {}, [
            el("h5", {}, "Error 错误"),
            el("div", { class: "wrap-pre txt-error" }, j.errorMessage),
          ]) : null,
          j.reason ? el("section", {}, [
            el("h5", {}, "Reason 原因"),
            el("div", { class: "wrap-pre" }, j.reason),
          ]) : null,
          el("section", {}, [
            el("h5", {}, "Meta 元数据"),
            el("div", { class: "mono small" }, [
              `id: ${j.id}`,
              el("br"),
              `sessionId: ${j.sessionId || "—"}`,
            ]),
          ]),
        ])),
      ]);

      tbody.appendChild(row);
      tbody.appendChild(detail);

      // 点击主行（除删除按钮）→ 切换 detail
      row.addEventListener("click", (ev) => {
        if (ev.target.closest(".row-del-btn")) return;
        const isOpen = !detail.hidden;
        detail.hidden = isOpen;
        row.classList.toggle("is-open", !isOpen);
      });
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
    return el("span", { class: value ? "pill pill--ok" : "pill pill--off" }, value ? "是" : "否");
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
  const TH = (en, zh) => el("th", {}, [
    el("div", { class: "th-en" }, en),
    el("div", { class: "th-zh" }, zh),
  ]);
  const t = el("table", {}, [
    el("thead", {}, [
      el("tr", {}, [
        TH("time", "时间"),
        TH("key", "键"),
        TH("value", "值"),
        TH("confidence", "置信度"),
        el("th", { class: "th-action" }, ""),
      ]),
    ]),
  ]);
  const tbody = el("tbody");
  for (const f of items) {
    const tr = el("tr", {}, [
      el("td", { class: "td-time" }, formatTime(f.createdAt)),
      el("td", { class: "mono" }, f.factKey),
      el("td", { class: "td-content", title: f.factValue }, shortText(f.factValue, 200)),
      el("td", {}, (f.confidence ?? 0).toFixed(2)),
      el("td", { class: "td-action" }, rowDeleteBtn(
        `/api/browse/facts/${f.id}`,
        `删除该条事实？\n\n${f.factKey} = ${shortText(f.factValue, 80)}`,
        () => tr.remove(),
      )),
    ]);
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  body.appendChild(el("div", { class: "table-wrap" }, [t]));
}

// ─── Identity tab (Phase CC-1) ─────────────────────────────────────
//
// 7 层认知架构第 1 层：21 字段人格底色。读 GET /api/character/identity，写 POST upsert。
// vocab 拉自 /api/character/identity/vocab，用于 trait / attachment / mode 等下拉。
async function renderIdentityTab(body, a) {
  body.innerHTML = "";
  body.appendChild(el("article", { "aria-busy": "true" }, "加载 identity…"));

  let identityResp, vocabResp;
  try {
    [identityResp, vocabResp] = await Promise.all([
      api.get("/api/character/identity", { assistantId: a.assistantId }),
      api.get("/api/character/identity/vocab"),
    ]);
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("article", {}, [
      el("h4", {}, "加载失败"),
      el("pre", {}, err.message),
    ]));
    return;
  }
  body.innerHTML = "";

  const id = identityResp.identity || {};
  const vocab = vocabResp;

  // 渲染表单：每个字段一行，受控词表用 multi-checkbox / select；0-1 floats 用 number input
  const form = el("article", {});
  form.appendChild(el("header", {}, [
    el("strong", {}, "Identity (21 fields)"),
    el("small", { class: "muted" }, id.identityVersion ? `  v${id.identityVersion}` : "  尚未配置"),
  ]));

  const grid = el("div", { class: "identity-grid" });

  // helper: 一行 dt（key + 中文翻译灰字）+ dd
  const row = (key, zhLabel, dd) => {
    grid.appendChild(el("dt", {}, [
      el("div", { class: "field-key" }, key),
      el("div", { class: "field-zh" }, zhLabel),
    ]));
    grid.appendChild(el("dd", {}, dd));
  };

  // 基本属性
  row("ageYears", "年龄（岁）",
    el("input", { id: "id-age", type: "number", value: id.ageYears ?? "", style: "width: 100px" }));
  row("genderExpression", "性别表达",
    el("input", { id: "id-gender", value: id.genderExpression || "" }));
  row("speakingStyle", "说话风格",
    el("textarea", { id: "id-speaking", rows: 3 }, id.speakingStyle || ""));
  row("worldview", "世界观 / 人生观",
    el("textarea", { id: "id-worldview", rows: 3 }, id.worldview || ""));

  // attachmentStyle: 自定义 combo（带中文释义）
  const attachCombo = makeCombo({
    value: id.attachmentStyle || "",
    options: vocab.attachmentStyles.map((s) => ({ value: s, zh: zhOf("attachmentStyle", s) })),
    placeholder: "(unset)",
  });
  row("attachmentStyle", "依恋类型", attachCombo.root);

  // socialStrategyDefault: 自定义 combo
  const stratCombo = makeCombo({
    value: id.socialStrategyDefault || "",
    options: vocab.socialStrategies.map((s) => ({ value: s, zh: zhOf("socialStrategy", s) })),
    placeholder: "(unset)",
  });
  row("socialStrategyDefault", "默认社交姿态（12 种 mode 之一）", stratCombo.root);

  // 0-1 floats
  row("emotionalSensitivity", "情绪敏感度（0-1，越高对事件反应越大）",
    el("input", { id: "id-sensitivity", type: "number", min: "0", max: "1", step: "0.05", value: id.emotionalSensitivity ?? "0.5", style: "width: 100px" }));
  row("empathyLevel", "共情度（0-1）",
    el("input", { id: "id-empathy", type: "number", min: "0", max: "1", step: "0.05", value: id.empathyLevel ?? "0.5", style: "width: 100px" }));
  row("expressiveness", "表达度（0-1，越高越外放）",
    el("input", { id: "id-expressive", type: "number", min: "0", max: "1", step: "0.05", value: id.expressiveness ?? "0.5", style: "width: 100px" }));

  // personalityTraits: multi-checkbox (35 项) — 每个 label 带中文
  const traitsBox = el("div", { class: "checkbox-grid" });
  const currentTraits = new Set(id.personalityTraits || []);
  for (const t of vocab.personalityTraits) {
    const cb = el("input", { type: "checkbox", value: t, name: "traits", checked: currentTraits.has(t) ? "checked" : false });
    traitsBox.appendChild(el("label", { class: "cb-label" }, [
      cb,
      el("span", { class: "cb-en" }, t),
      el("span", { class: "cb-zh" }, zhOf("trait", t)),
    ]));
  }
  row(`personalityTraits`, `人格特质（多选，共 ${vocab.personalityTraits.length} 项）`, traitsBox);

  // tensions: 8 sliders (0-1) — label 带中文释义
  const tensionsBox = el("div");
  const currentTensions = id.tensions || {};
  for (const t of vocab.tensions) {
    const v = currentTensions[t] ?? 0.5;
    tensionsBox.appendChild(el("div", { class: "slider-row" }, [
      el("label", { class: "slider-label" }, [
        el("span", { class: "slider-label-en" }, t),
        el("span", { class: "slider-label-zh" }, zhOf("tension", t)),
      ]),
      el("input", { id: `t-${t}`, "data-tension": t, type: "range", min: "0", max: "1", step: "0.05", value: String(v) }),
      el("span", { id: `tv-${t}`, class: "slider-value" }, String(v)),
    ]));
  }
  tensionsBox.addEventListener("input", (e) => {
    const tname = e.target?.dataset?.tension;
    if (tname) document.getElementById(`tv-${tname}`).textContent = e.target.value;
  });
  row(`tensions`, `内在张力（${vocab.tensions.length} 个维度，值靠近 1 偏向左项）`, tensionsBox);

  // careLanguages: give / receive 各 5 个 checkbox — 带中文
  const careGive = new Set((id.careLanguages?.give) || []);
  const careRecv = new Set((id.careLanguages?.receive) || []);
  const careGiveBox = el("div", { class: "checkbox-grid" });
  const careRecvBox = el("div", { class: "checkbox-grid" });
  for (const c of vocab.careLanguages) {
    careGiveBox.appendChild(el("label", { class: "cb-label" }, [
      el("input", { type: "checkbox", value: c, name: "care-give", checked: careGive.has(c) ? "checked" : false }),
      el("span", { class: "cb-en" }, c),
      el("span", { class: "cb-zh" }, zhOf("careLanguage", c)),
    ]));
    careRecvBox.appendChild(el("label", { class: "cb-label" }, [
      el("input", { type: "checkbox", value: c, name: "care-recv", checked: careRecv.has(c) ? "checked" : false }),
      el("span", { class: "cb-en" }, c),
      el("span", { class: "cb-zh" }, zhOf("careLanguage", c)),
    ]));
  }
  row("careLanguages.give", "关爱语言 · 给予方式", careGiveBox);
  row("careLanguages.receive", "关爱语言 · 接收方式", careRecvBox);

  // 数组字段 → multi-tag 输入器
  // 三类带 vocab 推荐的：insecurities / coreWounds / desires
  // 五类纯自定义：values / hardBoundaries / softBoundaries / avoidanceTopics / triggeringTopics
  const tagInputs = {};
  function tagField(key, zhLabel, currentArr, suggestions = [], suggestionsZhMap = null) {
    const tag = makeTagsInput({ values: currentArr || [], suggestions, suggestionsZhMap });
    tagInputs[key] = tag;
    row(key, zhLabel, tag.root);
  }
  tagField("values", "价值观 / 信条", id.values);
  tagField("hardBoundaries", "硬边界（不可逾越，每条≥2 字）", id.hardBoundaries);
  tagField("softBoundaries", "软边界（可协商）", id.softBoundaries);
  tagField("avoidanceTopics", "回避话题", id.avoidanceTopics);
  tagField("triggeringTopics", "触发话题（说到就敏感）", id.triggeringTopics);
  tagField("insecurities", "不安全感", id.insecurities, vocab.commonInsecurities, ZH.insecurity);
  tagField("coreWounds", "核心创伤", id.coreWounds, vocab.commonCoreWounds, ZH.wound);
  tagField("desires", "深层渴望", id.desires, vocab.commonDesires, ZH.desire);

  form.appendChild(grid);

  const saveBtn = el("button", {
    onclick: async (ev) => {
      ev.preventDefault();
      const btn = ev.currentTarget;
      btn.setAttribute("aria-busy", "true");
      const collectChecked = (name) =>
        Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map((n) => n.value);
      const tensions = {};
      for (const t of vocab.tensions) {
        tensions[t] = parseFloat(document.getElementById(`t-${t}`).value);
      }
      const fields = {
        ageYears: parseInt(document.getElementById("id-age").value, 10) || null,
        genderExpression: document.getElementById("id-gender").value,
        speakingStyle: document.getElementById("id-speaking").value,
        worldview: document.getElementById("id-worldview").value,
        personalityTraits: collectChecked("traits"),
        attachmentStyle: attachCombo.getValue() || null,
        socialStrategyDefault: stratCombo.getValue() || null,
        emotionalSensitivity: parseFloat(document.getElementById("id-sensitivity").value),
        empathyLevel: parseFloat(document.getElementById("id-empathy").value),
        expressiveness: parseFloat(document.getElementById("id-expressive").value),
        values: tagInputs.values.getValues(),
        hardBoundaries: tagInputs.hardBoundaries.getValues(),
        softBoundaries: tagInputs.softBoundaries.getValues(),
        avoidanceTopics: tagInputs.avoidanceTopics.getValues(),
        triggeringTopics: tagInputs.triggeringTopics.getValues(),
        insecurities: tagInputs.insecurities.getValues(),
        coreWounds: tagInputs.coreWounds.getValues(),
        desires: tagInputs.desires.getValues(),
        careLanguages: { give: collectChecked("care-give"), receive: collectChecked("care-recv") },
        tensions,
      };
      try {
        const resp = await api.post("/api/character/identity/upsert", { assistantId: a.assistantId, ...fields });
        showToast(`已保存（v${resp.identity.identityVersion}）`, "success");
      } catch (err) {
        const detail = err.payload?.error || err.message || "unknown";
        console.error("[identity-save] →", err.payload || err);
        showToast(`保存失败: ${detail}`, "error");
      } finally {
        btn.removeAttribute("aria-busy");
      }
    },
  }, "保存 Identity");
  form.appendChild(saveBtn);

  body.appendChild(form);
}

// ─── Cognition tab (Phase CC-2 / CC-3) ─────────────────────────────
//
// 把多维 dynamics + 长期话题 + 叙事段 + 关系反思 4 个数据源聚合在一个 tab，
// 这些是 LLM 行为决策的实际输入。
async function renderCognitionTab(body, a) {
  body.innerHTML = "";
  body.appendChild(el("article", { "aria-busy": "true" }, "加载认知层…"));

  let ctx, episodes, topics, reflections;
  try {
    [ctx, episodes, topics, reflections] = await Promise.all([
      api.post("/api/character/context", { assistantId: a.assistantId }),
      api.get("/api/character/episodes", { assistantId: a.assistantId, limit: 10 }),
      api.get("/api/character/topics", { assistantId: a.assistantId, limit: 30, includeInactive: "true" }),
      api.get("/api/character/reflections", { assistantId: a.assistantId, limit: 5 }),
    ]);
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("article", {}, [
      el("h4", {}, "加载失败"),
      el("pre", {}, err.message),
    ]));
    return;
  }
  body.innerHTML = "";

  // 1) Relationship Dynamics — 12 维条形图
  const dynamicsArticle = el("article", {});
  dynamicsArticle.appendChild(el("header", {}, [el("strong", {}, "Relationship Dynamics（12 维）")]));
  const dyn = ctx.relationshipDynamics;
  if (!dyn) {
    dynamicsArticle.appendChild(el("p", { class: "muted" }, "暂无数据 — 用户还未开始对话"));
  } else {
    const dimGrid = el("div", { class: "dim-grid" });
    const DIM_KEYS = [
      "trust", "dependency", "emotionalSafety", "attachment",
      "tension", "unresolvedConflict", "abandonmentFear", "reciprocityBalance",
      "emotionalCloseness", "socialDistance", "resentment", "gratitude",
    ];
    for (const k of DIM_KEYS) {
      const v = Number(dyn[k] ?? 0);
      const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
      const tone =
        ["tension", "unresolvedConflict", "abandonmentFear", "resentment"].includes(k) && v > 0.4 ? "bad" :
        ["trust", "emotionalSafety", "emotionalCloseness", "gratitude"].includes(k) && v > 0.5 ? "ok" :
        "neutral";
      dimGrid.appendChild(el("div", { class: "dim-row" }, [
        el("span", { class: "dim-label" }, [
          el("span", { class: "dim-label-en" }, k),
          el("span", { class: "dim-label-zh" }, zhOf("dynamicDim", k)),
        ]),
        el("div", { class: "dim-bar" }, [el("div", { class: `dim-fill dim-fill--${tone}`, style: `width: ${pct}%` })]),
        el("span", { class: "dim-value" }, v.toFixed(2)),
      ]));
    }
    dynamicsArticle.appendChild(dimGrid);
  }
  body.appendChild(dynamicsArticle);

  // 2) Latest Reflection
  const reflArticle = el("article", {});
  reflArticle.appendChild(el("header", {}, [el("strong", {}, "Relationship Reflection（最近 5 条）")]));
  const refList = reflections.reflections || [];
  if (!refList.length) {
    reflArticle.appendChild(el("p", { class: "muted" }, "尚无反思 — weekly cron 周日 04:30 跑，或调 admin/character/reflect 手动触发"));
  } else {
    for (const r of refList) {
      reflArticle.appendChild(el("div", { class: "reflection-card" }, [
        el("div", { class: "reflection-meta" }, [
          el("span", { class: "badge badge--neutral" }, r.reflectionType),
          " ",
          el("span", { class: "muted" }, formatTime(r.createdAt)),
          r.triggerReason ? " " : null,
          r.triggerReason ? el("span", { class: "badge badge--off" }, r.triggerReason) : null,
        ]),
        el("p", {}, r.summary || ""),
        el("div", { class: "reflection-tags" }, [
          r.emotionalTrend ? el("span", { class: "badge badge--neutral" }, `情绪：${r.emotionalTrend}`) : null,
          r.relationshipDirection ? el("span", { class: "badge badge--neutral" }, `方向：${r.relationshipDirection}`) : null,
        ]),
        (r.userNeeds && r.userNeeds.length) ? el("p", { class: "muted small" }, [el("strong", {}, "需求："), r.userNeeds.join("｜")]) : null,
        (r.concerns && r.concerns.length) ? el("p", { class: "muted small" }, [el("strong", {}, "关切："), r.concerns.join("｜")]) : null,
        (r.opportunities && r.opportunities.length) ? el("p", { class: "muted small" }, [el("strong", {}, "机会："), r.opportunities.join("｜")]) : null,
      ]));
    }
  }
  // 手动触发反思按钮
  reflArticle.appendChild(el("button", {
    class: "outline",
    onclick: async (ev) => {
      ev.preventDefault();
      const btn = ev.currentTarget;
      btn.setAttribute("aria-busy", "true");
      try {
        const resp = await api.post("/api/admin/character/reflect", {
          assistantId: a.assistantId,
          reflectionType: "manual",
          triggerReason: "ui_manual",
        });
        const r = resp.result || {};
        console.log("[reflect]", r);
        if (r.skipped) {
          const detail = r.error ? ` — ${r.error}` : "";
          showToast(`跳过：${r.reason}${detail}`, "warn");
        } else {
          showToast(`反思已生成（${r.reflection?.relationshipDirection || "stable"}）`, "success");
        }
        renderCognitionTab(body, a);
      } catch (err) {
        const detail = err.payload?.error || err.message;
        console.error("[reflect] →", err.payload || err);
        showToast(`反思失败: ${detail}`, "error");
      } finally {
        btn.removeAttribute("aria-busy");
      }
    },
  }, "立即反思（manual）"));
  body.appendChild(reflArticle);

  // 3) Episodes
  const epArticle = el("article", {});
  epArticle.appendChild(el("header", {}, [el("strong", {}, "Narrative Episodes（最近 10 条）")]));
  const epList = episodes.episodes || [];
  if (!epList.length) {
    epArticle.appendChild(el("p", { class: "muted" }, "暂无 — episode_builder cron 每天 03:30 跑，或调 admin/character/build-episodes 手动触发"));
  } else {
    for (const e of epList) {
      epArticle.appendChild(el("div", { class: "episode-card" }, [
        el("div", {}, [
          el("strong", {}, e.title),
          " ",
          el("span", { class: "badge badge--neutral" }, e.emotionalTone),
          " ",
          el("span", { class: "muted small" }, `importance ${Number(e.importance).toFixed(2)}`),
        ]),
        el("p", { class: "muted small" }, `${formatTime(e.timeRangeStart)} → ${formatTime(e.timeRangeEnd)}`),
        el("p", {}, e.summary || ""),
        (e.unresolvedThreads && e.unresolvedThreads.length) ? el("p", { class: "muted small" }, [el("strong", {}, "未化解："), e.unresolvedThreads.join("｜")]) : null,
      ]));
    }
  }
  epArticle.appendChild(el("button", {
    class: "outline",
    onclick: async (ev) => {
      ev.preventDefault();
      const btn = ev.currentTarget;
      btn.setAttribute("aria-busy", "true");
      try {
        const resp = await api.post("/api/admin/character/build-episodes", { assistantId: a.assistantId });
        const r = resp.result || {};
        console.log("[build-episodes]", r);
        if (r.skipped) {
          // 跳过的真原因：too_few_memories / llm_error / llm_parse_failed / no_profile
          const detail = r.error ? ` — ${r.error}` : (r.reason === "too_few_memories" ? `（仅扫到 ${r.memoriesScanned} 条 memory，<5 条不足以聚合）` : "");
          showToast(`跳过：${r.reason}${detail}`, "warn");
        } else {
          showToast(`已生成 ${r.episodesCreated || 0} 个 episode；topic 新建 ${r.newTopicsCreated || 0}，更新 ${r.topicsUpdated || 0}`, "success");
        }
        renderCognitionTab(body, a);
      } catch (err) {
        const detail = err.payload?.error || err.message;
        console.error("[build-episodes] →", err.payload || err);
        showToast(`构建失败: ${detail}`, "error");
      } finally {
        btn.removeAttribute("aria-busy");
      }
    },
  }, "立即构建 Episodes"));
  body.appendChild(epArticle);

  // 4) Topics — 7 状态机
  const topicArticle = el("article", {});
  topicArticle.appendChild(el("header", {}, [el("strong", {}, "Persistent Topics（含 dormant/resolved）")]));
  const tList = topics.topics || [];
  if (!tList.length) {
    topicArticle.appendChild(el("p", { class: "muted" }, "暂无 — episode_builder 识别 + admin 创建"));
  } else {
    for (const t of tList) {
      topicArticle.appendChild(el("div", { class: "topic-card" }, [
        el("strong", {}, t.topic),
        " ",
        el("span", { class: `badge topic-status--${t.status}` }, t.status),
        " ",
        el("span", { class: "muted small" }, `提及 ${t.mentionCount} 次, importance ${Number(t.importance).toFixed(2)}`),
        (t.aliases && t.aliases.length) ? el("p", { class: "muted small" }, `alias: ${t.aliases.join(", ")}`) : null,
        t.emotionalAssociation ? el("p", { class: "muted small" }, `情绪：${t.emotionalAssociation}`) : null,
      ]));
    }
  }
  body.appendChild(topicArticle);
}

// ─── Intent tab (Phase CC-4) ──────────────────────────────────────
//
// 实时显示 behaviorPlanner 的当前推荐 intent + 14 intent 评分对照 + socialMode。
// 调试用：看清楚"为什么这次 AI 没主动发消息"或"为什么 AI 选了这个姿态"。
async function renderIntentTab(body, a) {
  body.innerHTML = "";
  body.appendChild(el("article", { "aria-busy": "true" }, "评估 intent…"));

  let intentResp, vocabResp, ctxResp;
  try {
    [intentResp, vocabResp, ctxResp] = await Promise.all([
      api.get("/api/character/behavior-intent", { assistantId: a.assistantId }).catch((e) => {
        if (e.status === 404 && e.payload?.error === "no_character_state") {
          return { ok: false, error: "no_character_state" };
        }
        if (e.message === "bad_json_404") {
          return { ok: false, error: "endpoint_not_registered（服务端可能未重启）" };
        }
        throw e;
      }),
      api.get("/api/character/behavior-intent/vocab"),
      api.post("/api/character/context", { assistantId: a.assistantId }),
    ]);
    // 调试：把后端响应记下来，方便用户在控制台看
    console.log("[intent-tab] intentResp:", intentResp);
    console.log("[intent-tab] vocabResp:", vocabResp);
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("article", {}, [
      el("h4", {}, "加载失败"),
      el("pre", {}, err.message),
    ]));
    return;
  }
  body.innerHTML = "";

  // 1) Current intent
  const cur = el("article", {});
  cur.appendChild(el("header", {}, [el("strong", {}, "当前推荐 Intent")]));
  if (!intentResp.ok) {
    cur.appendChild(el("p", { class: "muted" }, `不可用：${intentResp.error || "unknown"}（角色还没 character_state，需要先有用户对话）`));
  } else {
    const intent = intentResp.intent;
    cur.appendChild(el("div", { class: "intent-headline" }, [
      el("span", { class: `badge badge--${intent === "none" ? "off" : "neutral"}`, style: "font-size: 1rem" }, intent),
      " ",
      el("span", { class: "muted" }, zhOf("intent", intent) || ""),
      " ",
      el("span", { class: "muted small" }, `优先级 ${intentResp.priority ?? 0}`),
      " ",
      el("span", { class: "muted small" }, `紧迫度 ${intentResp.urgency || "—"}`),
    ]));
    if (intentResp.suggestedSocialMode) {
      cur.appendChild(el("p", {}, [el("strong", {}, "建议姿态："), intentResp.suggestedSocialMode]));
    }
    if (intentResp.contentHint) {
      cur.appendChild(el("p", { class: "muted small" }, intentResp.contentHint));
    }
  }
  // current socialMode (来自 context)
  // socialMode.primary / secondary 是 {mode, score, prompt} 对象，渲染时只取 mode 字符串
  if (ctxResp.socialMode) {
    const primaryMode = ctxResp.socialMode.primary?.mode || ctxResp.socialMode.primary || "—";
    const secondaryMode = ctxResp.socialMode.secondary?.mode || ctxResp.socialMode.secondary;
    cur.appendChild(el("p", {}, [
      el("strong", {}, "实时 SocialMode："),
      el("span", { class: "badge badge--neutral" }, String(primaryMode)),
      secondaryMode ? " " : null,
      secondaryMode ? el("span", { class: "badge badge--off" }, `+${secondaryMode}`) : null,
    ]));
  }
  body.appendChild(cur);

  // 2) Score table — 14 intents 排序
  const scoreArticle = el("article", {});
  scoreArticle.appendChild(el("header", {}, [el("strong", {}, "14 Intents — 当前评分")]));
  const scores = intentResp.scores || {};
  // INTENT_DEFINITIONS 是 { intent: { description, suggestedMode, priority, urgency } } 的 map
  const intents = vocabResp.intents || {};
  const rows = Object.entries(intents).map(([name, def]) => ({
    intent: name,
    priority: def.priority,
    urgency: def.urgency,
    mode: def.suggestedMode || "—",
    description: def.description || "",
    score: Number(scores[name] ?? 0),
  })).sort((a, b) => b.score - a.score || b.priority - a.priority);

  const t = el("table");
  t.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", {}, "intent"),
    el("th", {}, "score"),
    el("th", {}, "priority"),
    el("th", {}, "urgency"),
    el("th", {}, "mode"),
    el("th", {}, "description"),
  ])]));
  const tbody = el("tbody");
  for (const r of rows) {
    const isWinner = r.intent === intentResp.intent;
    tbody.appendChild(el("tr", { class: isWinner ? "intent-winner" : "" }, [
      el("td", {}, [
        el("div", { class: "mono small" }, r.intent),
        el("div", { class: "muted small" }, zhOf("intent", r.intent) || ""),
      ]),
      el("td", { class: "mono" }, r.score.toFixed(0)),
      el("td", { class: "mono" }, String(r.priority)),
      el("td", {}, r.urgency || "—"),
      el("td", {}, r.mode),
      el("td", { class: "muted small" }, r.description),
    ]));
  }
  t.appendChild(tbody);
  scoreArticle.appendChild(el("div", { class: "table-wrap" }, [t]));
  body.appendChild(scoreArticle);
}

async function renderManageTab(body, a) {
  body.innerHTML = "";

  const isCharacterLike = isCharacterTypeLike(a.assistantType);

  if (isCharacterLike) {
    const togglesArticle = el("article", {}, [
      el("header", {}, [el("strong", {}, "自驱开关")]),
      el("p", { class: "muted" }, "切换后立即生效。控制本角色是否参与 lazy catchup 和 proactive plan 生成。"),
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
  } else {
    body.appendChild(
      el("article", { class: "muted" }, [
        el("header", {}, [el("strong", {}, "自驱开关已隐藏")]),
        el(
          "p",
          {},
          `当前角色类型为 "${a.assistantType || "default"}"（${assistantTypeLabel(a.assistantType)}），不适用自驱生活 / 主动消息。改为 "character" 类型即可显示开关。`
        ),
      ])
    );
  }

  const typeOptions = ["", "character", "writer", "default"];
  const typeSelect = el(
    "select",
    { class: "vis-select", id: "edit-type" },
    typeOptions.map((opt) =>
      el(
        "option",
        {
          value: opt,
          ...(opt === (a.assistantType || "") ? { selected: "selected" } : {}),
        },
        opt === "" ? "（未指定）" : `${opt} — ${assistantTypeLabel(opt)}`
      )
    )
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
    el("label", {}, [
      "assistantType",
      typeSelect,
      el(
        "small",
        { class: "muted" },
        " 与 chatbox-Android `MyAssistant.type` 对齐；character 类型才显示自驱开关。"
      ),
    ]),
    el(
      "button",
      {
        onclick: async (ev) => {
          ev.preventDefault();
          const name = document.getElementById("edit-name").value.trim();
          const bg = document.getElementById("edit-bg").value;
          const newType = document.getElementById("edit-type").value;
          try {
            const resp = await api.patch(
              `/api/browse/assistants/${encodeURIComponent(a.assistantId)}/profile`,
              {
                characterName: name || undefined,
                characterBackground: bg,
                assistantType: newType,
              }
            );
            a.characterName = resp.profile.characterName;
            a.characterBackground = resp.profile.characterBackground;
            a.assistantType = resp.profile.assistantType;
            showToast("已保存（type 改动需要刷新页面才能切换显示）", "ok");
          } catch (err) {
            showToast(`保存失败: ${err.message}`, "err");
          }
        },
      },
      "保存 Profile"
    ),
  ]);
  body.appendChild(profileForm);

  const newOps = el("article", {}, [
    el("header", {}, [el("strong", {}, "Catchup & Plans（推荐）")]),
    el("p", { class: "muted" }, "lazy catchup 按需补叙生活记忆；force=true 模式立即合成一条今日消息（绕过 trigger 评估，2 分钟后派发）。"),
    el("div", { class: "run-row" }, [
      el("label", {}, [
        "gap hours",
        el("input", {
          id: "catchup-gap-hours",
          type: "number",
          min: "1",
          max: "240",
          value: "6",
          style: "width: 80px",
        }),
      ]),
      el(
        "button",
        {
          class: "outline",
          onclick: async (ev) => {
            ev.preventDefault();
            const btn = ev.currentTarget;
            const hours = Number(document.getElementById("catchup-gap-hours").value || "6");
            const out = document.getElementById("ops-output");
            out.textContent = "running…";
            btn.setAttribute("aria-busy", "true");
            try {
              const now = Date.now();
              const resp = await api.post("/api/character/catchup", {
                assistantId: a.assistantId,
                lastInteractionAt: now - hours * 3600 * 1000,
                maxEvents: 5,
              });
              out.textContent = JSON.stringify(resp, null, 2);
              showToast(`catchup 完成: generated=${resp.generated ?? 0}`, "ok");
            } catch (err) {
              out.textContent = `error: ${err.message}\n${JSON.stringify(err.payload || {}, null, 2)}`;
              showToast(`catchup 失败: ${err.message}`, "err");
            } finally {
              btn.removeAttribute("aria-busy");
            }
          },
        },
        "立即补叙近期生活记忆"
      ),
    ]),
    el("div", { class: "run-row" }, [
      el(
        "button",
        {
          class: "outline",
          title: "force=true，绕过 trigger 评估，立即生成一条主动消息（2 分钟后派发）",
          onclick: async (ev) => {
            ev.preventDefault();
            const btn = ev.currentTarget;
            const out = document.getElementById("ops-output");
            out.textContent = "running…";
            btn.setAttribute("aria-busy", "true");
            try {
              const resp = await api.post("/api/proactive/regenerate-plans", {
                assistantId: a.assistantId,
                force: true,
              });
              out.textContent = JSON.stringify(resp, null, 2);
              showToast(`今日消息: generated=${resp.generated ?? 0}`, "ok");
            } catch (err) {
              out.textContent = `error: ${err.message}\n${JSON.stringify(err.payload || {}, null, 2)}`;
              showToast(`生成失败: ${err.message}`, "err");
            } finally {
              btn.removeAttribute("aria-busy");
            }
          },
        },
        "立即生成一条今日消息（强制）"
      ),
    ]),
    el("h5", {}, "结果"),
    el("pre", { id: "ops-output" }, "—"),
  ]);
  body.appendChild(newOps);
}

async function viewPlans() {
  const container = clearRoot();
  const head = el("article", {}, [
    el("header", {}, [el("strong", {}, "今日消息（主动 plan 队列）")]),
    el("div", { class: "filter-row" }, [
      el("label", {}, [
        "状态",
        (() => {
          const s = el("select", { class: "vis-select", id: "plan-status" });
          for (const opt of [
            { value: "pending", text: "pending" },
            { value: "sent", text: "sent" },
            { value: "cancelled", text: "cancelled" },
            { value: "failed", text: "failed" },
            { value: "all", text: "all" },
          ]) {
            s.appendChild(el("option", { value: opt.value }, opt.text));
          }
          return s;
        })(),
      ]),
      el("label", {}, [
        "AssistantId",
        el("input", { id: "plan-assistant", placeholder: "(可选，留空 = all)" }),
      ]),
      el("button", { id: "plan-apply" }, "刷新"),
      el(
        "button",
        {
          class: "outline",
          id: "plan-regen",
        },
        "重新评估全部角色（按 trigger）"
      ),
    ]),
  ]);
  container.appendChild(head);

  const tableWrap = el("div", { class: "table-wrap" });
  container.appendChild(tableWrap);

  function buildTable() {
    const t = el("table");
    t.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, "scheduled_at"),
          el("th", {}, "assistant"),
          el("th", {}, "trigger"),
          el("th", {}, "intent"),
          el("th", {}, "anchor"),
          el("th", {}, "draft"),
          el("th", {}, "status"),
          el("th", {}, "操作"),
        ]),
      ])
    );
    t.appendChild(el("tbody", { id: "plan-tbody" }));
    return t;
  }

  async function load() {
    tableWrap.innerHTML = "";
    tableWrap.appendChild(buildTable());
    const status = document.getElementById("plan-status").value;
    const assistantId = document.getElementById("plan-assistant").value.trim();
    const params = { status, limit: 200 };
    if (assistantId) params.assistantId = assistantId;
    let resp;
    try {
      resp = await api.get("/api/proactive/plans", params);
    } catch (err) {
      tableWrap.innerHTML = "";
      tableWrap.appendChild(el("article", {}, [
        el("h4", {}, "加载失败"),
        el("pre", {}, err.message),
      ]));
      return;
    }
    const tbody = document.getElementById("plan-tbody");
    if (!resp.items.length) {
      tbody.appendChild(
        el("tr", {}, [
          el("td", { colspan: "8", class: "muted" }, "无数据"),
        ])
      );
      return;
    }
    for (const p of resp.items) {
      const actionsTd = el("td", {});
      if (p.status === "pending") {
        actionsTd.appendChild(
          el(
            "button",
            {
              class: "outline",
              onclick: async () => {
                if (!confirm(`取消 plan ${p.id}?`)) return;
                try {
                  await request("DELETE", `/api/proactive/plans/${encodeURIComponent(p.id)}`, { body: { reason: "manual_ui" } });
                  showToast("已取消", "ok");
                  load();
                } catch (err) {
                  showToast(`取消失败: ${err.message}`, "err");
                }
              },
            },
            "取消"
          )
        );
      } else {
        actionsTd.appendChild(el("span", { class: "muted" }, "—"));
      }
      tbody.appendChild(
        el("tr", {}, [
          el("td", { class: "td-time" }, formatTime(p.scheduledAt)),
          el(
            "td",
            { class: "mono", title: p.assistantId },
            shortText(p.assistantId, 14)
          ),
          el("td", {}, p.triggerReason),
          el("td", {}, p.intent),
          el("td", {}, shortText(p.anchorTopic || "", 20)),
          el(
            "td",
            { class: "td-content" },
            el("details", {}, [
              el("summary", {}, shortText(p.draftBody || "", 40)),
              el("div", { class: "wrap-pre" }, p.draftBody || ""),
              p.rationale ? el("div", { class: "muted" }, `rationale: ${p.rationale}`) : null,
            ])
          ),
          el("td", {}, el("span", { class: `pill pill--${p.status}` }, p.status)),
          actionsTd,
        ])
      );
    }
  }

  document.getElementById("plan-apply").addEventListener("click", load);
  document.getElementById("plan-status").addEventListener("change", load);
  document.getElementById("plan-regen").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    btn.setAttribute("aria-busy", "true");
    try {
      const r = await api.post("/api/proactive/regenerate-plans", {});
      showToast(`生成完成: profiles=${r.profiles ?? 0} generated=${r.generated ?? 0}`, "ok");
      load();
    } catch (err) {
      showToast(`生成失败: ${err.message}`, "err");
    } finally {
      btn.removeAttribute("aria-busy");
    }
  });

  await load();
}

function parseHash() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) return { route: "home" };
  if (parts[0] === "search") return { route: "search" };
  if (parts[0] === "plans") return { route: "plans" };
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
  if (r.route === "plans") return viewPlans();
  if (r.route === "character") return viewCharacter(r.assistantId, r.tab);
  return viewHome();
}

window.addEventListener("hashchange", dispatch);
window.addEventListener("DOMContentLoaded", () => {
  startHealthPing();
  dispatch();
});
