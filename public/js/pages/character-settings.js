import { api } from "../api.js";
import { el, showToast } from "../el.js";
import { isCharacterTypeLike, assistantTypeLabel } from "../utils.js";
import { makeCombo } from "../components/combo.js";
import { showResultDialog, showExtractPreviewDialog } from "../components/dialogs.js";

export async function renderManageTab(body, a) {
  body.innerHTML = "";

  const isCharacterLike = isCharacterTypeLike(a.assistantType);

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

  const typeCombo = makeCombo({
    value: a.assistantType || "",
    options: [
      { value: "character", zh: "人物型陪伴角色" },
      { value: "writer", zh: "写作助手" },
      { value: "default", zh: "通用助手" },
    ],
    placeholder: "（未指定）",
  });

  const aiAnalyzeBtn = el("button", { class: "vis-btn-sm" }, "AI 分析");
  aiAnalyzeBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    aiAnalyzeBtn.setAttribute("aria-busy", "true");
    aiAnalyzeBtn.textContent = "分析中…";
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
      aiAnalyzeBtn.removeAttribute("aria-busy");
      aiAnalyzeBtn.textContent = "AI 分析";
    }
  });

  const profileForm = el("article", {}, [
    el("header", {}, [el("strong", {}, "Profile 编辑")]),
    el("label", {}, [
      "角色名称",
      el("input", { id: "edit-name", value: a.characterName || "" }),
    ]),
    el("div", { class: "field-with-action" }, [
      el("div", { class: "field-with-action__head" }, [
        el("label", { for: "edit-bg" }, "初始设定"),
        aiAnalyzeBtn,
      ]),
      el("textarea", { id: "edit-bg", rows: "6", style: "width:100%; margin:0;" }, a.characterBackground || ""),
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
}
