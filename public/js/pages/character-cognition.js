import { api } from "../api.js";
import { el, showToast } from "../el.js";
import { formatTime } from "../utils.js";
import { zhOf } from "../zh-labels.js";

// ─── Cognition tab (Phase CC-2 / CC-3) ─────────────────────────────
//
// 把多维 dynamics + 长期话题 + 叙事段 + 关系反思 4 个数据源聚合在一个 tab，
// 这些是 LLM 行为决策的实际输入。
export async function renderCognitionTab(body, a) {
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

  // 1) Character State 实时面板（mood / intimacy / energy / trend）
  // 这是 state_delta 实际落到哪里 —— cognition router 每轮 chat 都会动这几个数。
  renderCharacterStatePanel(body, ctx);

  // 2) Relationship Dynamics — 12 维条形图
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

  // 5) Prompt 预览（V_NEW_LEAN）—— 让 admin 看到 server 渲染好的 8 段 slots + assistantPrefill
  // 含一个简易 salient phrase 调试器：输入用户消息 → 看哪个 wound 被勾住
  renderPromptPreview(body, a, ctx);
}

// Character State 实时面板 —— mood / intimacy / energy / trend
// 数据来自 /character/context 的 emotion + characterState 字段。这是 cognition router
// state_delta 实际累加沉淀的地方；每一轮 chat 都会被 applyStateDelta 推动。
function renderCharacterStatePanel(parent, ctx) {
  const article = el("article", {});
  article.appendChild(el("header", {}, [
    el("strong", {}, "Character State · 实时"),
    el("small", { class: "muted", style: "margin-left: 0.5rem" },
      "cognition router 的 state_delta 每轮累加到这里"),
  ]));

  const emo = ctx.emotion;
  const st = ctx.characterState;
  if (!emo && !st) {
    article.appendChild(el("p", { class: "muted" }, "暂无 state —— 角色还没有用户对话"));
    parent.appendChild(article);
    return;
  }

  const grid = el("div", { class: "state-panel-grid" });

  // 当前心情 emotion
  if (emo?.current) {
    const c = emo.current;
    grid.appendChild(el("div", { class: "state-cell" }, [
      el("div", { class: "muted small" }, "当前情绪"),
      el("div", {}, [
        el("span", { class: "badge badge--neutral", style: "font-size: 0.95rem" }, c.zh || c.id),
        el("span", { class: "muted small", style: "margin-left: 0.3rem" }, `(${c.id})`),
      ]),
      el("div", { class: "muted small" },
        `强度 ${Math.round((c.intensity || 0) * 100)}%  ·  ` +
        `valence ${(c.valence || 0).toFixed(2)}  ·  arousal ${(c.arousal || 0).toFixed(2)}`),
    ]));
  }

  // 压抑情绪
  if (emo?.suppressed) {
    const s = emo.suppressed;
    grid.appendChild(el("div", { class: "state-cell state-cell--warn" }, [
      el("div", { class: "muted small" }, "压抑情绪 / 内里压着"),
      el("div", {}, [
        el("span", { class: "badge badge--off" }, s.zh || s.id),
        el("span", { class: "muted small", style: "margin-left: 0.3rem" },
          `强度 ${Math.round((s.intensity || 0) * 100)}%`),
      ]),
    ]));
  }

  // 关系亲密度 + level（payload 来自 relationshipStateView：nested mood/relationship/energy/focus）
  const rel = st?.relationship;
  if (rel) {
    grid.appendChild(el("div", { class: "state-cell" }, [
      el("div", { class: "muted small" }, "关系 / 亲密度"),
      el("div", {}, [
        el("span", { class: "badge badge--on" },
          `Lv ${rel.level ?? 0}${rel.levelName ? ` · ${rel.levelName}` : ""}`),
        el("span", { class: "muted small", style: "margin-left: 0.3rem" },
          `intimacy ${(rel.intimacyScore ?? 0).toFixed(1)} / 200`),
      ]),
      el("div", { class: "muted small" },
        `总轮次 ${rel.totalTurns ?? 0}`),
    ]));
  }

  // 精力
  const energyVal = typeof st?.energy === "number" ? st.energy : st?.energy?.value;
  if (typeof energyVal === "number") {
    const e = energyVal;
    const label = e > 0.6 ? "充沛" : e > 0.3 ? "普通" : "疲惫";
    const tone = e > 0.6 ? "ok" : e > 0.3 ? "neutral" : "bad";
    grid.appendChild(el("div", { class: "state-cell" }, [
      el("div", { class: "muted small" }, "精力"),
      el("div", {}, [
        el("span", { class: `badge badge--${tone === "ok" ? "on" : tone === "bad" ? "off" : "neutral"}` },
          label),
        el("span", { class: "muted small", style: "margin-left: 0.3rem" }, e.toFixed(2)),
      ]),
    ]));
  }

  // 24h 趋势
  if (emo?.trend24h != null) {
    const t = emo.trend24h;
    const label = Math.abs(t) < 0.1 ? "平稳" : t > 0 ? "向好" : "走低";
    grid.appendChild(el("div", { class: "state-cell" }, [
      el("div", { class: "muted small" }, "24h 心情趋势"),
      el("div", {}, [
        el("span", { class: "badge badge--neutral" }, label),
        el("span", { class: "muted small", style: "margin-left: 0.3rem" },
          (t > 0 ? "+" : "") + t.toFixed(2)),
      ]),
    ]));
  }

  // 未化解情绪话题
  if (emo?.unresolvedTopic) {
    grid.appendChild(el("div", { class: "state-cell state-cell--warn" }, [
      el("div", { class: "muted small" }, "未化解的情绪话题"),
      el("div", {}, emo.unresolvedTopic),
    ]));
  }

  article.appendChild(grid);
  article.appendChild(el("p", { class: "muted small", style: "margin-top: 0.5rem" },
    "提示：去『意图』tab 跑一句测试消息，能看到 cognition router 输出的 state_delta 如何推动这几个数。"));
  parent.appendChild(article);
}

// V_NEW_LEAN Prompt 预览组件 —— 显示 mergedSystem + assistantPrefill + 选择性注意调试。
function renderPromptPreview(parent, a, initialCtx) {
  const article = el("article", {});
  article.appendChild(el("header", {}, [
    el("strong", {}, "Prompt 预览（V_NEW_LEAN）"),
    el("small", { class: "muted" }, "  server 渲染好的 8 段 slots + assistantPrefill。输入测试消息看 salient phrase 触发。"),
  ]));

  // 调试输入框：用户消息 → 触发 salient phrase
  const debugInput = el("input", {
    type: "text",
    placeholder: "输入一条用户消息试一下（如：算了，随便吧）",
    style: "margin-bottom: 0.5rem",
  });
  const debugBtn = el("button", { class: "outline secondary" }, "刷新预览");

  // 三个段落容器
  const sysBlock = el("pre", { class: "wrap-pre prompt-block" }, "");
  const userBlock = el("pre", { class: "wrap-pre prompt-block" }, "");
  const salientBlock = el("div", { class: "muted small" }, "");
  const metricsBlock = el("p", { class: "muted small" }, "");

  function fillFromCtx(ctx) {
    sysBlock.textContent = ctx.mergedSystem || "（请输入测试消息后点刷新，查看完整 system prompt）";
    userBlock.textContent = ctx.assistantPrefill || "(独白段为空 —— 当前角色无显著情绪/关系异常)";
    if (ctx.salientPhrase) {
      const sp = ctx.salientPhrase;
      salientBlock.innerHTML = "";
      salientBlock.appendChild(el("strong", {}, "选择性注意命中："));
      salientBlock.appendChild(document.createTextNode(` "${sp.phrase}" `));
      salientBlock.appendChild(el("span", { class: "badge badge--neutral" }, sp.triggerSource));
      salientBlock.appendChild(document.createTextNode(` → ${zhOf("insecurity", sp.triggerSource) || zhOf("wound", sp.triggerSource) || ""}`));
    } else {
      salientBlock.textContent = "选择性注意：未触发（输入测试消息可调试）";
    }
    const sysLen = (ctx.mergedSystem || "").length;
    const usrLen = (ctx.assistantPrefill || "").length;
    metricsBlock.textContent = sysLen
      ? `mergedSystem ${sysLen} chars · assistantPrefill ${usrLen} chars · combined ${sysLen + usrLen}`
      : "";
  }

  fillFromCtx(initialCtx);

  debugBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const userInput = debugInput.value.trim();
    if (!userInput) {
      showToast("请先输入一条测试消息", "warn");
      return;
    }
    debugBtn.setAttribute("aria-busy", "true");
    try {
      const newCtx = await api.post("/api/chat/context", {
        assistantId: a.assistantId,
        userInput,
      });
      fillFromCtx(newCtx);
    } catch (err) {
      showToast(`预览失败: ${err.message}`, "error");
    } finally {
      debugBtn.removeAttribute("aria-busy");
    }
  });

  article.appendChild(el("div", { class: "prompt-debug-row" }, [debugInput, debugBtn]));
  article.appendChild(salientBlock);
  article.appendChild(el("h5", { class: "muted small" }, "完整 system（mergedSystem，含 8 个 slot）"));
  article.appendChild(sysBlock);
  article.appendChild(el("h5", { class: "muted small" }, "assistantPrefill（[此刻] 独白段，每条消息变）"));
  article.appendChild(userBlock);
  article.appendChild(metricsBlock);

  parent.appendChild(article);
}
