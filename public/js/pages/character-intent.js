import { api } from "../api.js";
import { el } from "../el.js";
import { zhOf } from "../zh-labels.js";

// ─── Intent tab (Phase CC-4) ──────────────────────────────────────
//
// 实时显示 behaviorPlanner 的当前推荐 intent + 14 intent 评分对照 + socialMode。
// 调试用：看清楚"为什么这次 AI 没主动发消息"或"为什么 AI 选了这个姿态"。
export async function renderIntentTab(body, a) {
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

  // 1.5) Attention 1h — 角色当下 latched on 什么（V3 新增）
  // 数据来自 behavior-intent endpoint 的 attention1h 字段（withAttention=true 默认）
  const attn = intentResp.attention1h;
  const attnArticle = el("article", {});
  attnArticle.appendChild(
    el("header", {}, [
      el("strong", {}, "Attention · 最近 1 小时"),
      el("span", { class: "muted small", style: "margin-left: 8px" }, "（hot path 与 proactive 共享）"),
    ])
  );
  if (!attn || (!attn.topics?.length && !attn.innerFocus)) {
    attnArticle.appendChild(
      el("p", { class: "muted" }, "无数据：最近 1 小时没有对话，或 LLM 提取失败。")
    );
  } else {
    if (Array.isArray(attn.topics) && attn.topics.length) {
      attnArticle.appendChild(
        el("p", {}, [
          el("strong", {}, "话题："),
          el("span", { class: "muted" }, attn.topics.join(" / ")),
        ])
      );
    }
    if (attn.innerFocus) {
      attnArticle.appendChild(
        el("p", {}, [
          el("strong", {}, "内心焦点："),
          el("span", {}, attn.innerFocus),
        ])
      );
    }
    if (attn.emotionalTone) {
      attnArticle.appendChild(
        el("p", {}, [
          el("strong", {}, "整体基调："),
          el("span", { class: "badge badge--neutral" }, attn.emotionalTone),
          " ",
          el("span", { class: "muted small" }, `（基于 ${attn.turnCount || 0} 条 turn）`),
        ])
      );
    }
    attnArticle.appendChild(
      el(
        "p",
        { class: "muted small" },
        "提示：这一层影响 chat hot path 的 register 选择，也会增强 behavior intent 的判断（如 abandonment 焦点 / 未解决话题）。"
      )
    );
  }
  body.appendChild(attnArticle);

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
