import { api, request } from "../api.js";
import { el, clearRoot, showToast } from "../el.js";
import { formatTime, shortText } from "../utils.js";

export async function viewPlans() {
  const container = clearRoot();
  const head = el("article", {}, [
    el("header", {}, [el("strong", {}, "今日消息（主动 plan 队列）")]),
    el("div", { class: "filter-row" }, [
      el("label", {}, [
        "状态",
        (() => {
          const s = el("select", { class: "vis-select", id: "plan-status" });
          for (const opt of [
            { value: "pending", text: "pending" },
            { value: "sent", text: "sent" },
            { value: "cancelled", text: "cancelled" },
            { value: "failed", text: "failed" },
            { value: "all", text: "all" },
          ]) {
            s.appendChild(el("option", { value: opt.value }, opt.text));
          }
          return s;
        })(),
      ]),
      el("label", {}, [
        "AssistantId",
        el("input", { id: "plan-assistant", placeholder: "(可选，留空 = all)" }),
      ]),
      el("button", { id: "plan-apply" }, "刷新"),
      el(
        "button",
        {
          class: "outline",
          id: "plan-regen",
        },
        "重新评估全部角色（按 trigger）"
      ),
    ]),
  ]);
  container.appendChild(head);

  const tableWrap = el("div", { class: "table-wrap" });
  container.appendChild(tableWrap);

  function buildTable() {
    const t = el("table");
    t.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, "scheduled_at"),
          el("th", {}, "assistant"),
          el("th", {}, "trigger"),
          el("th", {}, "intent"),
          el("th", {}, "anchor"),
          el("th", {}, "draft"),
          el("th", {}, "status"),
          el("th", {}, "操作"),
        ]),
      ])
    );
    t.appendChild(el("tbody", { id: "plan-tbody" }));
    return t;
  }

  async function load() {
    tableWrap.innerHTML = "";
    tableWrap.appendChild(buildTable());
    const status = document.getElementById("plan-status").value;
    const assistantId = document.getElementById("plan-assistant").value.trim();
    const params = { status, limit: 200 };
    if (assistantId) params.assistantId = assistantId;
    let resp;
    try {
      resp = await api.get("/api/proactive/plans", params);
    } catch (err) {
      tableWrap.innerHTML = "";
      tableWrap.appendChild(el("article", {}, [
        el("h4", {}, "加载失败"),
        el("pre", {}, err.message),
      ]));
      return;
    }
    const tbody = document.getElementById("plan-tbody");
    if (!resp.items.length) {
      tbody.appendChild(
        el("tr", {}, [
          el("td", { colspan: "8", class: "muted" }, "无数据"),
        ])
      );
      return;
    }
    for (const p of resp.items) {
      const actionsTd = el("td", {});
      if (p.status === "pending") {
        actionsTd.appendChild(
          el(
            "button",
            {
              class: "outline",
              onclick: async () => {
                if (!confirm(`取消 plan ${p.id}?`)) return;
                try {
                  await request("DELETE", `/api/proactive/plans/${encodeURIComponent(p.id)}`, { body: { reason: "manual_ui" } });
                  showToast("已取消", "ok");
                  load();
                } catch (err) {
                  showToast(`取消失败: ${err.message}`, "err");
                }
              },
            },
            "取消"
          )
        );
      } else {
        actionsTd.appendChild(el("span", { class: "muted" }, "—"));
      }
      tbody.appendChild(
        el("tr", {}, [
          el("td", { class: "td-time" }, formatTime(p.scheduledAt)),
          el(
            "td",
            { class: "mono", title: p.assistantId },
            shortText(p.assistantId, 14)
          ),
          el("td", {}, p.triggerReason),
          el("td", {}, p.intent),
          el("td", {}, shortText(p.anchorTopic || "", 20)),
          el(
            "td",
            { class: "td-content" },
            el("details", {}, [
              el("summary", {}, shortText(p.draftBody || "", 40)),
              el("div", { class: "wrap-pre" }, p.draftBody || ""),
              p.rationale ? el("div", { class: "muted" }, `rationale: ${p.rationale}`) : null,
            ])
          ),
          el("td", {}, el("span", { class: `pill pill--${p.status}` }, p.status)),
          actionsTd,
        ])
      );
    }
  }

  document.getElementById("plan-apply").addEventListener("click", load);
  document.getElementById("plan-status").addEventListener("change", load);
  document.getElementById("plan-regen").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    btn.setAttribute("aria-busy", "true");
    try {
      const r = await api.post("/api/proactive/regenerate-plans", {});
      showToast(`生成完成: profiles=${r.profiles ?? 0} generated=${r.generated ?? 0}`, "ok");
      load();
    } catch (err) {
      showToast(`生成失败: ${err.message}`, "err");
    } finally {
      btn.removeAttribute("aria-busy");
    }
  });

  await load();
}
