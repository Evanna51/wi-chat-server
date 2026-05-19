import { api } from "../api.js";
import { el } from "../el.js";
import { formatTime, shortText } from "../utils.js";
import { rowDeleteBtn } from "../components/dialogs.js";

export async function renderMemoryTab(body, a) {
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
