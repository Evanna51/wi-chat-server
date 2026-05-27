import { api } from "../api.js";
import { el, showToast } from "../el.js";
import { zhOf } from "../zh-labels.js";

// ─── Intent tab（重构 2026-05-24）──────────────────────────────────
//
// 系统有两套"意图"：
//   1. Cognition router 的 response_stance —— 角色对**这一句**的响应意图
//      （empathize / reflect / probe / stay_silent / ...）。每一轮 chat 都跑。
//   2. Proactive behaviorPlanner 的 14 个 intent —— 角色**主动发起**的意图
//      （reassure_after_conflict / life_check_in / ...）。proactive 派发链用。
// 它们解决不同问题，分两个 section 展示，避免混淆。
//
// 同时加调试输入框：试一句用户消息 → 看完整 cognition 输出（inner / state_delta / ...）。

export async function renderIntentTab(body, a) {
  body.innerHTML = "";
  body.appendChild(el("article", { "aria-busy": "true" }, "加载意图层…"));

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
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("article", {}, [
      el("h4", {}, "加载失败"),
      el("pre", {}, err.message),
    ]));
    return;
  }
  body.innerHTML = "";

  // ─── Section 1: Cognition Router 调试 ─────────────────────────────────
  renderCognitionDebugSection(body, a);

  // ─── Section 2: Attention 1h（chat hot path / proactive 共享）────────
  renderAttentionSection(body, intentResp.attention1h);

  // ─── Section 3: Proactive Intent（主动发起意图）──────────────────────
  renderProactiveIntentSection(body, intentResp, vocabResp, ctxResp);
}

// ─── Section 1: Cognition Router 调试 ─────────────────────────────────
//
// 通过 POST /api/chat/context 跑一次完整 cognition router → 拿到 routerDecision
// 含 inner / register_tags / response_stance / state_delta / state_delta_applied。
// 这是 chat hot path 的真实决策，是除 Prompt Preview 之外最近"角色当下心理"的接口。
function renderCognitionDebugSection(parent, a) {
  const article = el("article", { class: "cognition-debug" });
  article.appendChild(el("header", {}, [
    el("strong", {}, "对话决策（Cognition Router）"),
    el("small", { class: "muted", style: "margin-left: 0.5rem" },
      "—— 角色对这一句的响应意图 + 内心独白 + state_delta；与下方『主动意图』是两套路径"),
  ]));
  article.appendChild(el("p", { class: "muted small" },
    "输入一句测试消息，跑一次完整 chat/context 看 cognition router 输出。" +
    "实际派发时也会落进 character_state（mood / intimacy / energy 实时移动）。"));

  const input = el("input", {
    type: "text",
    placeholder: "试一句用户消息，如：『你忙吧，我不烦你了』",
    style: "width: 100%; margin-bottom: 0.5rem",
    id: "cognition-debug-input",
  });
  const runBtn = el("button", { class: "outline" }, "跑一次 cognition router");
  const resultDiv = el("div", { class: "cognition-result", style: "margin-top: 0.75rem" });

  article.appendChild(input);
  article.appendChild(runBtn);
  article.appendChild(resultDiv);

  runBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const userInput = input.value.trim();
    if (!userInput) {
      showToast("先填一句测试消息", "warn");
      return;
    }
    runBtn.setAttribute("aria-busy", "true");
    resultDiv.innerHTML = "";
    try {
      const resp = await api.post("/api/chat/context", {
        assistantId: a.assistantId,
        userInput,
      });
      renderCognitionResult(resultDiv, resp);
    } catch (err) {
      resultDiv.appendChild(el("pre", { class: "muted" }, `失败：${err.message}`));
    } finally {
      runBtn.removeAttribute("aria-busy");
    }
  });
  parent.appendChild(article);
}

function renderCognitionResult(container, ctxResp) {
  const rd = ctxResp.routerDecision || {};

  // 1) Register tags + response_stance + budget + skill_ids（一行 summary）
  const summaryBar = el("div", { class: "cognition-summary" }, [
    el("div", {}, [
      el("strong", {}, "Register Tags："),
      ...(rd.register_tags?.length
        ? rd.register_tags.map((t) =>
            el("span", { class: "badge badge--neutral", style: "margin-right: 4px" },
              `${t}${zhOf("registerTag", t) ? " · " + zhOf("registerTag", t) : ""}`))
        : [el("span", { class: "muted" }, "（空）")]),
    ]),
    el("div", { style: "margin-top: 4px" }, [
      el("strong", {}, "Response Stance："),
      rd.response_stance
        ? el("span", { class: "badge badge--on", style: "font-size: 0.95rem" },
            `${rd.response_stance}${zhOf("responseStance", rd.response_stance)
              ? " · " + zhOf("responseStance", rd.response_stance) : ""}`)
        : el("span", { class: "muted" }, "—"),
    ]),
    el("div", { style: "margin-top: 4px" }, [
      el("strong", {}, "Skills："),
      el("span", { class: "mono small" }, (rd.skill_ids || []).join(" / ") || "—"),
      el("span", { class: "muted small", style: "margin-left: 0.5rem" },
        `budget=${rd.budget || "—"}`),
    ]),
    rd.reason
      ? el("div", { class: "muted small", style: "margin-top: 4px" },
          `reason: ${rd.reason}`)
      : null,
  ]);
  container.appendChild(summaryBar);

  // 2) Inner thought（核心：角色第一人称内心独白）
  if (rd.inner) {
    const inner = rd.inner;
    const innerCard = el("div", { class: "inner-thought-card" });
    innerCard.appendChild(el("h5", {}, "💭 内心独白（thinking-before-thinking）"));
    if (inner.subtext_read) {
      innerCard.appendChild(el("p", {}, [
        el("strong", { class: "muted" }, "潜台词： "),
        el("span", {}, inner.subtext_read),
      ]));
    }
    if (inner.my_feeling) {
      innerCard.appendChild(el("p", {}, [
        el("strong", { class: "muted" }, "我的感受： "),
        el("span", {}, inner.my_feeling),
      ]));
    }
    if (inner.honesty_check) {
      innerCard.appendChild(el("p", {}, [
        el("strong", { class: "muted" }, "诚实自检： "),
        el("span", { class: "honesty-text" }, inner.honesty_check),
      ]));
    }
    if (!inner.subtext_read && !inner.my_feeling && !inner.honesty_check) {
      innerCard.appendChild(el("p", { class: "muted" },
        "（cognition router fallback —— LLM 未触发，未做内心独白）"));
    }
    container.appendChild(innerCard);
  }

  // 3) State delta（mood / intimacy / energy shift）
  if (rd.state_delta || rd.state_delta_applied) {
    renderStateDeltaCard(container, rd.state_delta, rd.state_delta_applied);
  }

  // 4) Layers + tools
  const meta = el("div", { class: "cognition-meta" });
  meta.appendChild(el("h5", {}, "信息层 / 工具"));
  const layerEntries = Object.entries(rd.layers || {})
    .filter(([, v]) => v && v > 0)
    .map(([k, v]) => `${k}=${v}`);
  meta.appendChild(el("p", { class: "muted small" }, [
    el("strong", {}, "Layers ON："),
    " ",
    layerEntries.length ? layerEntries.join(" / ") : "—",
  ]));
  meta.appendChild(el("p", { class: "muted small" }, [
    el("strong", {}, "Client tools："),
    " ",
    (rd.client_tools || []).join(", ") || "—",
  ]));
  if (rd.server_tools?.length) {
    meta.appendChild(el("p", { class: "muted small" }, [
      el("strong", {}, "Server tools："),
      " ",
      rd.server_tools.map((t) =>
        `${t.tool}(${t.args?.query ? `"${t.args.query.slice(0, 30)}"` : ""})`).join(", "),
    ]));
  }
  container.appendChild(meta);

  // 5) mergedSystem 简略 preview（折叠）
  if (ctxResp.mergedSystem) {
    container.appendChild(el("details", {}, [
      el("summary", { class: "muted" }, `mergedSystem 预览（${ctxResp.mergedSystem.length} chars）`),
      el("pre", { class: "wrap-pre prompt-block", style: "max-height: 300px; overflow: auto" },
        ctxResp.mergedSystem),
    ]));
  }
}

function renderStateDeltaCard(container, delta, applied) {
  const card = el("div", { class: "state-delta-card" });
  card.appendChild(el("h5", {}, "📊 State Delta（落 character_state）"));

  // 显示 5 个 numeric deltas + 颜色
  const FIELDS = [
    { key: "mood_valence_delta", label: "心情正负向" },
    { key: "mood_intensity_delta", label: "情绪强度" },
    { key: "intimacy_delta", label: "亲密度", scale: 1 },
    { key: "energy_delta", label: "精力" },
    { key: "suppressed_intensity_delta", label: "压抑情绪" },
  ];
  const grid = el("div", { class: "state-delta-grid" });
  for (const f of FIELDS) {
    const v = Number(delta?.[f.key] ?? 0);
    const tone = v > 0.05 ? "pos" : v < -0.05 ? "neg" : "zero";
    grid.appendChild(el("div", { class: `delta-cell delta-cell--${tone}` }, [
      el("div", { class: "muted small" }, f.label),
      el("div", { class: "mono" }, (v >= 0 ? "+" : "") + v.toFixed(2)),
    ]));
  }
  card.appendChild(grid);

  if (delta?.mood_emotion_hint) {
    card.appendChild(el("p", { class: "muted small" }, [
      el("strong", {}, "情绪切换 hint："),
      el("span", { class: "mono" }, delta.mood_emotion_hint),
    ]));
  }
  if (delta?.reason) {
    card.appendChild(el("p", { class: "muted small" }, [
      el("strong", {}, "原因："),
      delta.reason,
    ]));
  }

  // applied 结果
  if (applied) {
    const status = applied.applied
      ? el("span", { class: "badge badge--on" }, "已落 DB")
      : el("span", { class: "badge badge--off" }, `未落（${applied.reason || "—"}）`);
    card.appendChild(el("p", {}, [el("strong", {}, "落库结果："), " ", status]));
    if (applied.applied && applied.after) {
      const after = applied.after;
      card.appendChild(el("p", { class: "muted small" }, [
        `落库后：mood=${after.mood_emotion}, valence=${after.mood_valence?.toFixed(2)}, `,
        `intimacy=${after.intimacy_score?.toFixed(1)}, energy=${after.energy?.toFixed(2)}, `,
        `level=${after.relationship_level}`,
      ]));
    }
  }

  container.appendChild(card);
}

// ─── Section 2: Attention 1h ──────────────────────────────────────────
function renderAttentionSection(parent, attn) {
  const article = el("article", {});
  article.appendChild(el("header", {}, [
    el("strong", {}, "Attention · 最近 1 小时"),
    el("small", { class: "muted", style: "margin-left: 0.5rem" },
      "（chat hot path 与 proactive 共享）"),
  ]));
  if (!attn || (!attn.topics?.length && !attn.innerFocus)) {
    article.appendChild(el("p", { class: "muted" },
      "无数据：最近 1 小时没有对话，或 LLM 提取失败。"));
  } else {
    if (Array.isArray(attn.topics) && attn.topics.length) {
      article.appendChild(el("p", {}, [
        el("strong", {}, "话题："),
        el("span", { class: "muted" }, attn.topics.join(" / ")),
      ]));
    }
    if (attn.innerFocus) {
      article.appendChild(el("p", {}, [
        el("strong", {}, "内心焦点："),
        el("span", {}, attn.innerFocus),
      ]));
    }
    if (attn.emotionalTone) {
      article.appendChild(el("p", {}, [
        el("strong", {}, "整体基调："),
        el("span", { class: "badge badge--neutral" }, attn.emotionalTone),
        " ",
        el("span", { class: "muted small" }, `（基于 ${attn.turnCount || 0} 条 turn）`),
      ]));
    }
    article.appendChild(el("p", { class: "muted small" },
      "影响 chat hot path 的 register 选择 + behavior intent 评估（abandonment / 未解决话题）。"));
  }
  parent.appendChild(article);
}

// ─── Section 3: Proactive Intent（14 个，主动发起意图）────────────────
function renderProactiveIntentSection(parent, intentResp, vocabResp, ctxResp) {
  const article = el("article", {});
  article.appendChild(el("header", {}, [
    el("strong", {}, "主动意图（Proactive Behavior Intent）"),
    el("small", { class: "muted", style: "margin-left: 0.5rem" },
      "—— 角色主动发起消息时选哪种 intent；与上方『对话决策』不是一回事"),
  ]));

  if (!intentResp.ok) {
    article.appendChild(el("p", { class: "muted" },
      `不可用：${intentResp.error || "unknown"}（角色还没 character_state，需要先有用户对话）`));
    parent.appendChild(article);
    return;
  }

  // Current winner + meta
  const intent = intentResp.intent;
  article.appendChild(el("div", { class: "intent-headline" }, [
    el("span", {
      class: `badge badge--${intent === "none" ? "off" : "on"}`,
      style: "font-size: 1rem",
    }, intent),
    " ",
    el("span", { class: "muted" }, zhOf("intent", intent) || ""),
    " ",
    el("span", { class: "muted small" }, `优先级 ${intentResp.priority ?? 0}`),
    " ",
    el("span", { class: "muted small" }, `紧迫度 ${intentResp.urgency || "—"}`),
  ]));
  if (intentResp.suggestedSocialMode) {
    article.appendChild(el("p", {}, [
      el("strong", {}, "建议姿态："),
      intentResp.suggestedSocialMode,
    ]));
  }
  if (intentResp.contentHint) {
    article.appendChild(el("p", { class: "muted small" }, intentResp.contentHint));
  }
  // SocialMode（来自 context）
  if (ctxResp.socialMode) {
    const primaryMode = ctxResp.socialMode.primary?.mode || ctxResp.socialMode.primary || "—";
    const secondaryMode = ctxResp.socialMode.secondary?.mode || ctxResp.socialMode.secondary;
    article.appendChild(el("p", {}, [
      el("strong", {}, "实时 SocialMode："),
      el("span", { class: "badge badge--neutral" }, String(primaryMode)),
      secondaryMode ? " " : null,
      secondaryMode ? el("span", { class: "badge badge--off" }, `+${secondaryMode}`) : null,
    ]));
  }

  // Scoring table
  const scores = intentResp.scores || {};
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
    const isWinner = r.intent === intent;
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
  article.appendChild(el("div", { class: "table-wrap" }, [t]));
  parent.appendChild(article);
}
