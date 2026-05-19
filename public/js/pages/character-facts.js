import { api } from "../api.js";
import { el } from "../el.js";
import { formatTime, shortText } from "../utils.js";
import { rowDeleteBtn } from "../components/dialogs.js";

export async function renderFactsTab(body, a) {
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
