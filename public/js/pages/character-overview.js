import { api } from "../api.js";
import { el } from "../el.js";
import { formatTime, shortText } from "../utils.js";

export async function renderOverviewTab(body, a) {
  body.innerHTML = "";
  body.appendChild(el("article", { "aria-busy": "true" }, "加载…"));
  const [convResp, journalResp] = await Promise.all([
    api.get("/api/browse/conversations", { assistantId: a.assistantId, limit: 3 }),
    api.get("/api/browse/journal", { assistantId: a.assistantId, limit: 3 }),
  ]);
  body.innerHTML = "";

  const profile = el("article", {}, [
    el("header", {}, [el("strong", {}, "Profile")]),
    el("dl", { class: "config-dl" }, [
      el("dt", {}, "characterName"),
      el("dd", {}, a.characterName || ""),
      el("dt", {}, "characterBackground"),
      el("dd", { class: "wrap-pre" }, a.characterBackground || "(空)"),
      el("dt", {}, "lastSessionId"),
      el("dd", { class: "mono" }, a.lastSessionId || "—"),
      el("dt", {}, "lastProactiveCheckAt"),
      el("dd", {}, formatTime(a.lastProactiveCheckAt)),
      el("dt", {}, "createdAt / updatedAt"),
      el("dd", {}, `${formatTime(a.createdAt)} / ${formatTime(a.updatedAt)}`),
    ]),
  ]);
  body.appendChild(profile);

  const stateBlock = el("article", {}, [
    el("header", {}, [el("strong", {}, "State")]),
    el("dl", { class: "config-dl" }, [
      el("dt", {}, "totalTurns"),
      el("dd", {}, String(a.state?.totalTurns ?? 0)),
      el("dt", {}, "activeSessionId"),
      el("dd", { class: "mono" }, a.state?.activeSessionId || "—"),
      el("dt", {}, "lastUserMessageAt"),
      el("dd", {}, formatTime(a.state?.lastUserMessageAt)),
      el("dt", {}, "lastProactiveAt"),
      el("dd", {}, formatTime(a.state?.lastProactiveAt)),
    ]),
  ]);
  body.appendChild(stateBlock);

  const recentTurnsBlock = el("article", {}, [
    el("header", {}, [el("strong", {}, "最近 3 条对话")]),
  ]);
  if (!convResp.items.length) {
    recentTurnsBlock.appendChild(el("p", { class: "muted" }, "暂无"));
  } else {
    for (const t of convResp.items) {
      recentTurnsBlock.appendChild(
        el("div", { class: `turn turn--${t.role}` }, [
          el("div", { class: "turn-meta" }, [
            el("strong", {}, t.role),
            " ",
            el("small", {}, formatTime(t.createdAt)),
          ]),
          el("div", { class: "turn-body" }, t.content),
        ])
      );
    }
  }
  body.appendChild(recentTurnsBlock);

  const recentJournalBlock = el("article", {}, [
    el("header", {}, [el("strong", {}, "最近 3 条行为日志")]),
  ]);
  if (!journalResp.items.length) {
    recentJournalBlock.appendChild(el("p", { class: "muted" }, "暂无"));
  } else {
    for (const j of journalResp.items) {
      recentJournalBlock.appendChild(
        el("div", { class: "journal-mini" }, [
          el("div", {}, [
            el("strong", {}, j.runType),
            " ",
            el("small", { class: "muted" }, formatTime(j.createdAt)),
            " ",
            el("span", { class: `pill pill--${j.status}` }, j.status),
          ]),
          j.messageIntent
            ? el("div", { class: "muted" }, `intent: ${j.messageIntent}`)
            : null,
          j.reason ? el("div", {}, `reason: ${shortText(j.reason, 200)}`) : null,
        ])
      );
    }
  }
  body.appendChild(recentJournalBlock);
}
