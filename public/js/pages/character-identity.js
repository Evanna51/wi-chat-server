import { api } from "../api.js";
import { el, showToast } from "../el.js";
import { ZH, zhOf } from "../zh-labels.js";
import { makeCombo } from "../components/combo.js";
import { makeTagsInput } from "../components/tags-input.js";
import { showExtractPreviewDialog } from "../components/dialogs.js";

// ─── Identity tab (Phase CC-1) ─────────────────────────────────────
//
// 7 层认知架构第 1 层：21 字段人格底色。读 GET /api/character/identity，写 POST upsert。
// vocab 拉自 /api/character/identity/vocab，用于 trait / attachment / mode 等下拉。
export async function renderIdentityTab(body, a) {
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
      // 把 identity 字段 + lore 显示出来给 admin 看，提供"应用"按钮一键写入
      showExtractPreviewDialog(a, result, () => renderIdentityTab(body, a));
    } catch (err) {
      showToast(`请求失败: ${err.message}`, "error");
    } finally {
      aiExtractBtn.removeAttribute("aria-busy");
      aiExtractBtn.textContent = "🤖 AI 分析 setup_prompt";
    }
  });
  form.appendChild(el("header", {}, [
    el("strong", {}, "Identity (21 fields)"),
    el("small", { class: "muted" }, id.identityVersion ? `  v${id.identityVersion}` : "  尚未配置"),
    aiExtractBtn,
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
  row("genderExpression", "性别表达（自由文本，如 feminine / masculine / androgynous）",
    el("input", { id: "id-gender", value: id.genderExpression || "" }));

  // pronouns: input + datalist（3 preset 自动补全 + 允许自定义如 xe/xem）
  // 这是 system <role> "Speak as <obj>" 的代词来源 —— 留空会默认 they/them
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
  row(`tensions`, `内在张力（${vocab.tensions.length} 个维度）`, tensionsBox);

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

  // CC-5.B: skills 字段。后端支持 string | { name, examples } 两种格式。
  // UI 用 tags 编辑名字（多选 / 自定义），保存时智能 merge：
  //   - 名字仍在新 tag 列表 → 保留原 object（不丢 examples）
  //   - 名字被删 → 整条丢
  //   - 新名字 → string 形式加进去（暂无 examples，需要 examples 走 API）
  const originalSkills = id.skills || [];
  const skillNamesNow = originalSkills.map((s) => (typeof s === "string" ? s : s.name));
  const skillsHasExamples = originalSkills.some((s) => typeof s === "object" && Array.isArray(s.examples) && s.examples.length);
  tagField("skills", "表达招式", skillNamesNow, vocab.commonSkills || [], ZH.skill);
  if (skillsHasExamples) {
    // 提示有现存 examples，删除某 skill 名时 examples 也会丢
    grid.lastChild.appendChild(el("p", { class: "muted small" }, "（部分招式带角色专属 example，删除该招式名会一并丢失）"));
  }

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
        // skills: 把 tag input 的字符串名字映射回原始 object（保留 examples）
        skills: (() => {
          const editedNames = tagInputs.skills.getValues();
          return editedNames.map((name) => {
            const orig = originalSkills.find((s) =>
              typeof s === "string" ? s === name : s.name === name
            );
            // 原本是 object 形态（带 examples）→ 保留整个 object
            if (orig && typeof orig === "object") return orig;
            // 原本是 string，或 UI 新加的 → 用 string 形态
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
  form.appendChild(saveBtn);

  body.appendChild(form);
}
