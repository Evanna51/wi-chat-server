import { api } from "../api.js";
import { el, clearRoot } from "../el.js";
import { escapeHtml, formatTime } from "../utils.js";

export async function viewSearch() {
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
