import { api } from "../api.js";
import { el, showToast } from "../el.js";
import { ZH, zhOf } from "../zh-labels.js";
import { isCharacterTypeLike, assistantTypeLabel } from "../utils.js";
import { makeCombo } from "../components/combo.js";
import { makeTagsInput } from "../components/tags-input.js";
import { showResultDialog, showExtractPreviewDialog } from "../components/dialogs.js";

export async function renderManageTab(body, a) {
  body.innerHTML = "";

  const isCharacterLike = isCharacterTypeLike(a.assistantType);

  // ── 自驱开关 ──────────────────────────────────────────────────────────
  if (isCharacterLike) {
    const catchupBtn = el("button", { class: "vis-btn-sm" }, "立即补叙");
    const proactiveBtn = el("button", { class: "vis-btn-sm" }, "立即消息");

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
          " 生活",
        ]),
        catchupBtn,
      ]),
      el("div", { class: "switch-row" }, [
        el("label", {}, [
          el("input", {
            type: "checkbox",
            role: "switch",
            id: "tg-proactive",
            checked: a.allowProactiveMessage ? "checked" : false,
          }),
          " 主动消息",
        ]),
        proactiveBtn,
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

    catchupBtn.addEventListener("click", async () => {
      catchupBtn.setAttribute("aria-busy", "true");
      try {
        const resp = await api.post("/api/character/catchup", {
          assistantId: a.assistantId,
          lastInteractionAt: Date.now() - 6 * 3600 * 1000,
          maxEvents: 5,
        });
        showResultDialog("补叙结果", resp);
        showToast(`catchup 完成: generated=${resp.generated ?? 0}`, "ok");
      } catch (err) {
        showToast(`catchup 失败: ${err.message}`, "err");
      } finally {
        catchupBtn.removeAttribute("aria-busy");
      }
    });

    proactiveBtn.addEventListener("click", async () => {
      proactiveBtn.setAttribute("aria-busy", "true");
      try {
        const resp = await api.post("/api/proactive/regenerate-plans", {
          assistantId: a.assistantId,
          force: true,
        });
        showResultDialog("主动消息结果", resp);
        showToast(`今日消息: generated=${resp.generated ?? 0}`, "ok");
      } catch (err) {
        showToast(`生成失败: ${err.message}`, "err");
      } finally {
        proactiveBtn.removeAttribute("aria-busy");
      }
    });
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

  // ── Profile 编辑 ──────────────────────────────────────────────────────
  const typeCombo = makeCombo({
    value: a.assistantType || "",
    options: [
      { value: "character", zh: "人物型陪伴角色" },
      { value: "writer", zh: "写作助手" },
      { value: "default", zh: "通用助手" },
    ],
    placeholder: "（未指定）",
  });

  const profileForm = el("article", {}, [
    el("header", {}, [el("strong", {}, "Profile 编辑")]),
    el("label", {}, [
      "角色名称",
      el("input", { id: "edit-name", value: a.characterName || "" }),
    ]),
    el("label", {}, [
      "初始设定",
      el("textarea", { id: "edit-bg", rows: "6", style: "width:100%; margin-top:0.3rem;" }, a.characterBackground || ""),
    ]),
    el("label", {}, [
      "类型",
      el("div", { style: "margin-top: 0.3rem;" }, [typeCombo.root]),
    ]),
    el(
      "button",
      {
        onclick: async (ev) => {
          ev.preventDefault();
          const name = document.getElementById("edit-name").value.trim();
          const bg = document.getElementById("edit-bg").value;
          const newType = typeCombo.getValue();
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

  // ── Identity（21 字段）—— 异步加载 ────────────────────────────────────
  const identityWrap = el("div");
  body.appendChild(identityWrap);
  identityWrap.appendChild(el("article", { "aria-busy": "true" }, "加载 Identity…"));

  let identityResp, vocabResp;
  try {
    [identityResp, vocabResp] = await Promise.all([
      api.get("/api/character/identity", { assistantId: a.assistantId }),
      api.get("/api/character/identity/vocab"),
    ]);
  } catch (err) {
    identityWrap.innerHTML = "";
    identityWrap.appendChild(el("article", {}, [
      el("h4", {}, "Identity 加载失败"),
      el("pre", {}, err.message),
    ]));
    return;
  }
  identityWrap.innerHTML = "";

  const id = identityResp.identity || {};
  const vocab = vocabResp;

  const aiExtractBtn = el("button", {
    class: "outline secondary small",
    style: "margin-left: 12px; font-size: 12px; padding: 4px 12px;",
  }, "🤖 AI 分析 setup_prompt");
  aiExtractBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    aiExtractBtn.setAttribute("aria-busy", "true");
    aiExtractBtn.textContent = "分析中（本地 LLM 跑约 10-30s）...";
    try {
      const result = await api.post("/api/character/extract", { assistantId: a.assistantId });
      if (!result.ok) {
        showToast(`提炼失败: ${result.error || "unknown"}`, "error");
        return;
      }
      showExtractPreviewDialog(a, result, () => renderManageTab(body, a));
    } catch (err) {
      showToast(`请求失败: ${err.message}`, "error");
    } finally {
      aiExtractBtn.removeAttribute("aria-busy");
      aiExtractBtn.textContent = "🤖 AI 分析 setup_prompt";
    }
  });

  const form = el("article", {});
  form.appendChild(el("header", {}, [
    el("strong", {}, "Identity (21 fields)"),
    el("small", { class: "muted" }, id.identityVersion ? `  v${id.identityVersion}` : "  尚未配置"),
    aiExtractBtn,
  ]));

  const grid = el("div", { class: "identity-grid" });

  const row = (key, zhLabel, dd) => {
    grid.appendChild(el("dt", {}, [
      el("div", { class: "field-key" }, key),
      el("div", { class: "field-zh" }, zhLabel),
    ]));
    grid.appendChild(el("dd", {}, dd));
  };

  row("ageYears", "年龄（岁）",
    el("input", { id: "id-age", type: "number", value: id.ageYears ?? "", style: "width: 100px" }));
  row("genderExpression", "性别表达（自由文本，如 feminine / masculine / androgynous）",
    el("input", { id: "id-gender", value: id.genderExpression || "" }));

  const pronounsList = el("datalist", { id: "pronoun-presets" });
  for (const p of vocab.pronounPresets || ["she/her", "he/him", "they/them"]) {
    pronounsList.appendChild(el("option", { value: p }));
  }
  const pronounsInput = el("input", {
    id: "id-pronouns",
    list: "pronoun-presets",
    value: id.pronouns || "",
    placeholder: "she/her | he/him | they/them（留空 → they/them）",
  });
  row("pronouns", "英文人称代词（驱动 voice anchor 渲染，避免错称）",
    el("div", {}, [pronounsInput, pronounsList]));
  row("speakingStyle", "说话风格",
    el("textarea", { id: "id-speaking", rows: 3 }, id.speakingStyle || ""));
  row("worldview", "世界观 / 人生观",
    el("textarea", { id: "id-worldview", rows: 3 }, id.worldview || ""));

  const attachCombo = makeCombo({
    value: id.attachmentStyle || "",
    options: vocab.attachmentStyles.map((s) => ({ value: s, zh: zhOf("attachmentStyle", s) })),
    placeholder: "(unset)",
  });
  row("attachmentStyle", "依恋类型", attachCombo.root);

  const stratCombo = makeCombo({
    value: id.socialStrategyDefault || "",
    options: vocab.socialStrategies.map((s) => ({ value: s, zh: zhOf("socialStrategy", s) })),
    placeholder: "(unset)",
  });
  row("socialStrategyDefault", "默认社交姿态（12 种 mode 之一）", stratCombo.root);

  row("emotionalSensitivity", "情绪敏感度（0-1，越高对事件反应越大）",
    el("input", { id: "id-sensitivity", type: "number", min: "0", max: "1", step: "0.05", value: id.emotionalSensitivity ?? "0.5", style: "width: 100px" }));
  row("empathyLevel", "共情度（0-1）",
    el("input", { id: "id-empathy", type: "number", min: "0", max: "1", step: "0.05", value: id.empathyLevel ?? "0.5", style: "width: 100px" }));
  row("expressiveness", "表达度（0-1，越高越外放）",
    el("input", { id: "id-expressive", type: "number", min: "0", max: "1", step: "0.05", value: id.expressiveness ?? "0.5", style: "width: 100px" }));

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
  row(`tensions`, `内在张力（${vocab.tensions.length} 个维度）`, tensionsBox);

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

  const originalSkills = id.skills || [];
  const skillNamesNow = originalSkills.map((s) => (typeof s === "string" ? s : s.name));
  const skillsHasExamples = originalSkills.some((s) => typeof s === "object" && Array.isArray(s.examples) && s.examples.length);
  tagField("skills", "表达招式", skillNamesNow, vocab.commonSkills || [], ZH.skill);
  if (skillsHasExamples) {
    grid.lastChild.appendChild(el("p", { class: "muted small" }, "（部分招式带角色专属 example，删除该招式名会一并丢失）"));
  }

  form.appendChild(grid);

  const saveIdentityBtn = el("button", {
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
        pronouns: document.getElementById("id-pronouns").value.trim(),
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
        skills: (() => {
          const editedNames = tagInputs.skills.getValues();
          return editedNames.map((name) => {
            const orig = originalSkills.find((s) =>
              typeof s === "string" ? s === name : s.name === name
            );
            if (orig && typeof orig === "object") return orig;
            return name;
          });
        })(),
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
  form.appendChild(saveIdentityBtn);

  identityWrap.appendChild(form);
}
