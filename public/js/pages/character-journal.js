import { api } from "../api.js";
import { el } from "../el.js";
import { formatTime, shortText } from "../utils.js";
import { rowDeleteBtn } from "../components/dialogs.js";

// 行为日志: runType / status 中文映射
const RUN_TYPE_ZH = {
  life_tick: "生活记忆",
  proactive_message_tick: "主动消息评估",
  initiate_tick: "主动发起",
  catchup_tick: "补叙",
  next_push_schedule: "下一条预排",
  plan_generation_tick: "Plan 生成",
  dead_letter_alert: "死信告警",
};
const STATUS_ZH = {
  ok: "正常",
  error: "出错",
  skipped: "跳过",
  cancelled: "取消",
  pending: "待处理",
};

export async function renderJournalTab(body, a) {
  body.innerHTML = "";
  const filter = el("div", { class: "journal-filter" }, [
    (() => {
      const s = el("select", { class: "vis-select", id: "j-runtype" });
      for (const opt of [
        { value: "all", text: "全部" },
        { value: "next_push_schedule", text: "next_push_schedule（下一条预排）" },
        { value: "plan_generation_tick", text: "plan_generation_tick（Plan 生成）" },
        { value: "catchup_tick", text: "catchup_tick（补叙）" },
        { value: "life_tick", text: "life_tick（生活记忆）" },
        { value: "proactive_message_tick", text: "proactive_message_tick（主动消息评估）" },
        { value: "initiate_tick", text: "initiate_tick（主动发起）" },
        { value: "dead_letter_alert", text: "dead_letter_alert（死信告警）" },
      ]) {
        s.appendChild(el("option", { value: opt.value }, opt.text));
      }
      return el("label", { class: "filter-field" }, [
        el("span", { class: "filter-label" }, "runType"),
        el("span", { class: "filter-label-zh" }, "事件类型"),
        s,
      ]);
    })(),
    el("label", { class: "filter-field" }, [
      el("span", { class: "filter-label" }, "from"),
      el("span", { class: "filter-label-zh" }, "起始时间"),
      el("input", { class: "vis-input", type: "datetime-local", id: "j-from" }),
    ]),
    el("label", { class: "filter-field" }, [
      el("span", { class: "filter-label" }, "to"),
      el("span", { class: "filter-label-zh" }, "结束时间"),
      el("input", { class: "vis-input", type: "datetime-local", id: "j-to" }),
    ]),
    el("button", { class: "outline filter-apply-btn", onclick: () => load(true) }, "应用筛选"),
  ]);
  body.appendChild(filter);

  const tableWrap = el("div", { class: "table-wrap" });
  body.appendChild(tableWrap);
  const moreWrap = el("div", { class: "more-wrap" });
  body.appendChild(moreWrap);

  let nextBefore = null;

  // 双语表头
  const TH = (en, zh) => el("th", {}, [
    el("div", { class: "th-en" }, en),
    el("div", { class: "th-zh" }, zh),
  ]);

  function buildHeader() {
    const t = el("table", { class: "journal-table" });
    t.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          TH("time", "时间"),
          TH("runType", "事件类型"),
          TH("status", "状态"),
          TH("persist", "落库"),
          TH("initiate", "已发"),
          TH("intent", "意图"),
          TH("draft / reason", "草稿 / 原因"),
          el("th", { class: "th-action" }, ""),
        ]),
      ])
    );
    t.appendChild(el("tbody", { id: "journal-tbody" }));
    return t;
  }

  function dtToMs(value) {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.getTime();
  }

  async function load(reset = true) {
    if (reset) {
      tableWrap.innerHTML = "";
      tableWrap.appendChild(buildHeader());
      nextBefore = null;
    }
    const runType = document.getElementById("j-runtype").value;
    const from = dtToMs(document.getElementById("j-from").value);
    const to = dtToMs(document.getElementById("j-to").value);
    const params = {
      assistantId: a.assistantId,
      limit: 100,
    };
    if (runType !== "all") params.runType = runType;
    if (from !== undefined) params.from = from;
    if (to !== undefined) params.to = to;
    if (!reset && nextBefore) params.before = nextBefore;
    const resp = await api.get("/api/browse/journal", params);
    const tbody = document.getElementById("journal-tbody");
    for (const j of resp.items) {
      const cls = [];
      if (j.shouldPersist === true) cls.push("row-persist");
      if (j.shouldInitiate === true) cls.push("row-initiate");
      if (j.status === "error") cls.push("row-error");
      const draftFull = j.draftMessage || "";
      const draftSummary = draftFull
        ? shortText(draftFull, 60)
        : (j.errorMessage ? shortText(j.errorMessage, 60) : (j.reason ? shortText(j.reason, 60) : "—"));
      const reasonShort = draftFull && (j.errorMessage || j.reason)
        ? shortText(j.errorMessage || j.reason, 80)
        : "";

      const row = el("tr", { class: ["journal-row", ...cls].join(" ") }, [
        el("td", { class: "td-time" }, formatTime(j.createdAt)),
        el("td", {}, [
          el("div", { class: "mono small" }, j.runType),
          el("div", { class: "muted small" }, RUN_TYPE_ZH[j.runType] || ""),
        ]),
        el("td", {}, el("span", { class: `pill pill--${j.status}` }, STATUS_ZH[j.status] || j.status)),
        el("td", {}, renderTri(j.shouldPersist)),
        el("td", {}, renderTri(j.shouldInitiate)),
        el("td", { class: "muted small" }, j.messageIntent || "—"),
        el("td", { class: "td-draft" }, [
          el("div", { class: "td-draft__sum" }, draftSummary),
          reasonShort ? el("div", { class: "td-draft__reason" }, reasonShort) : null,
          el("span", { class: "td-draft__expand" }, "▾"),
        ]),
        el("td", { class: "td-action" }, rowDeleteBtn(
          `/api/browse/journal/${encodeURIComponent(j.id)}`,
          "",
          () => { row.remove(); detail.remove(); },
        )),
      ]);

      // 展开行：占满整行宽度，显示完整 draft + reason + error + meta
      const detail = el("tr", { class: "journal-detail", hidden: "hidden" }, [
        el("td", { colspan: 8 }, el("div", { class: "journal-detail__grid" }, [
          draftFull ? el("section", {}, [
            el("h5", {}, "Draft 草稿"),
            el("div", { class: "wrap-pre" }, draftFull),
          ]) : null,
          j.errorMessage ? el("section", {}, [
            el("h5", {}, "Error 错误"),
            el("div", { class: "wrap-pre txt-error" }, j.errorMessage),
          ]) : null,
          j.reason ? el("section", {}, [
            el("h5", {}, "Reason 原因"),
            el("div", { class: "wrap-pre" }, j.reason),
          ]) : null,
          el("section", {}, [
            el("h5", {}, "Meta 元数据"),
            el("div", { class: "mono small" }, [
              `id: ${j.id}`,
              el("br"),
              `sessionId: ${j.sessionId || "—"}`,
            ]),
          ]),
        ])),
      ]);

      tbody.appendChild(row);
      tbody.appendChild(detail);

      // 点击主行（除删除按钮）→ 切换 detail
      row.addEventListener("click", (ev) => {
        if (ev.target.closest(".row-del-btn")) return;
        const isOpen = !detail.hidden;
        detail.hidden = isOpen;
        row.classList.toggle("is-open", !isOpen);
      });
    }
    nextBefore = resp.nextBefore;
    moreWrap.innerHTML = "";
    if (nextBefore) {
      moreWrap.appendChild(
        el("button", { class: "outline", onclick: () => load(false) }, "加载更早")
      );
    }
  }

  function renderTri(value) {
    if (value === null || value === undefined) return el("span", { class: "muted" }, "—");
    return el("span", { class: value ? "pill pill--ok" : "pill pill--off" }, value ? "是" : "否");
  }

  await load(true);
}
