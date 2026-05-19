import { el, showToast } from "../el.js";
import { api } from "../api.js";

/**
 * 行内删除按钮：物理删（不可恢复），点击 → DELETE → 移除该行 / 触发 onSuccess。
 * @param {string} url     DELETE 目标
 * @param {string} _legacyMsg 已废弃（保留位以兼容老 caller）
 * @param {function} onDeleted  删除成功回调（用于移除行 / 刷新视图）
 */
export function rowDeleteBtn(url, _legacyMsg, onDeleted) {
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

export function showResultDialog(title, data) {
  document.getElementById("vis-result-dialog")?.remove();
  const dlg = document.createElement("dialog");
  dlg.id = "vis-result-dialog";
  dlg.className = "vis-result-dialog";

  const closeBtn = el("button", { class: "vis-btn-sm" }, "关闭");
  closeBtn.addEventListener("click", () => { dlg.close(); dlg.remove(); });

  const pre = el("pre", { class: "vis-result-pre" }, JSON.stringify(data, null, 2));
  dlg.appendChild(el("article", {}, [
    el("header", { style: "display:flex; align-items:center; justify-content:space-between;" }, [
      el("strong", {}, title),
      closeBtn,
    ]),
    pre,
  ]));

  dlg.addEventListener("click", (ev) => { if (ev.target === dlg) { dlg.close(); dlg.remove(); } });
  document.body.appendChild(dlg);
  dlg.showModal();
}

// ─── AI 提炼 preview dialog ─────────────────────────────────────────
//
// 给 identity tab 的"AI 分析"按钮用。展示 LLM 提炼出的 identity 字段 + 净化 lore，
// 让 admin review；点"应用"调 identity/upsert + lore/save 落库。
export function showExtractPreviewDialog(a, result, onApplied) {
  const dlg = document.createElement("dialog");
  dlg.style.cssText =
    "max-width:680px; width:92%; padding:20px; border-radius:12px; border:0; " +
    "background:white; box-shadow:0 8px 32px rgba(0,0,0,0.15);";

  const id = result.identity || {};
  const lore = result.lore || "";

  // 字段行
  const idLines = [];
  for (const [k, v] of Object.entries(id)) {
    const displayV = typeof v === "string" ? v : JSON.stringify(v);
    idLines.push(`${k}: ${displayV}`);
  }
  const idPre = el("pre", {
    style: "max-height:280px; overflow:auto; font-size:11px; background:#f5f5f7; " +
           "padding:12px; border-radius:8px; white-space:pre-wrap; word-break:break-word;",
  }, idLines.join("\n") || "(无字段)");

  const lorePre = el("pre", {
    style: "max-height:200px; overflow:auto; font-size:12px; background:#f5f5f7; " +
           "padding:12px; border-radius:8px; white-space:pre-wrap; word-break:break-word; margin-top:8px;",
  }, lore || "(空)");

  const applyBtn = el("button", {}, "应用并保存");
  const cancelBtn = el("button", { class: "outline" }, "取消");
  cancelBtn.addEventListener("click", () => dlg.close());
  applyBtn.addEventListener("click", async () => {
    applyBtn.setAttribute("aria-busy", "true");
    try {
      if (Object.keys(id).length > 0) {
        await api.post("/api/character/identity/upsert", { assistantId: a.assistantId, ...id });
      }
      await api.post("/api/character/lore/save", { assistantId: a.assistantId, lore });
      showToast("已应用并保存（identity + lore）", "success");
      dlg.close();
      if (typeof onApplied === "function") onApplied();
    } catch (err) {
      showToast(`保存失败: ${err.message}`, "error");
      applyBtn.removeAttribute("aria-busy");
    }
  });

  dlg.appendChild(el("h3", { style: "margin:0 0 12px 0" }, "🤖 AI 提炼结果"));
  dlg.appendChild(el("p", { class: "muted small", style: "margin:0 0 16px 0" },
    `提炼耗时 ${result.extractionMs} ms · 字段 ${Object.keys(id).length} 项 · lore ${lore.length} 字`));
  dlg.appendChild(el("h5", { style: "margin:8px 0 4px 0" }, "📋 Identity 字段"));
  dlg.appendChild(idPre);
  dlg.appendChild(el("h5", { style: "margin:12px 0 4px 0" }, "📖 Lore（净化后）"));
  dlg.appendChild(lorePre);
  dlg.appendChild(el("div", { style: "display:flex; gap:12px; justify-content:flex-end; margin-top:16px;" },
    [cancelBtn, applyBtn]));

  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", ""); // fallback for older browsers
}
