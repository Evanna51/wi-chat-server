import { api } from "../api.js";
import { el } from "../el.js";
import { formatTime } from "../utils.js";

export async function renderConversationTab(body, a) {
  body.innerHTML = "";
  const sessionResp = await api.get("/api/browse/sessions", { assistantId: a.assistantId });
  const sessions = sessionResp.sessions || [];

  const layout = el("div", { class: "conv-layout" });
  const left = el("aside", { class: "conv-sessions" });
  const right = el("section", { class: "conv-stream" });
  layout.appendChild(left);
  layout.appendChild(right);
  body.appendChild(layout);

  left.appendChild(el("h4", {}, "Sessions"));
  if (!sessions.length) {
    left.appendChild(el("p", { class: "muted" }, "无 session"));
  }

  const sessionState = { active: sessions[0]?.sessionId || null };
  const sessionLinks = [];
  for (const s of sessions) {
    const item = el(
      "a",
      {
        href: "#",
        class: `session-item ${s.sessionId === sessionState.active ? "session-item--active" : ""}`,
        onclick: (ev) => {
          ev.preventDefault();
          sessionState.active = s.sessionId;
          for (const l of sessionLinks) l.classList.remove("session-item--active");
          item.classList.add("session-item--active");
          loadStream();
        },
      },
      [
        el("div", { class: "mono small-mono" }, s.sessionId),
        el(
          "small",
          { class: "muted" },
          `${s.turnCount} 轮 / ${formatTime(s.lastAt)}`
        ),
      ]
    );
    sessionLinks.push(item);
    left.appendChild(item);
  }

  let oldestCreatedAt = null;
  let nextBefore = null;

  async function loadStream(append = false) {
    if (!append) {
      right.innerHTML = "";
      oldestCreatedAt = null;
      nextBefore = null;
    }
    if (!sessionState.active) {
      right.appendChild(el("p", { class: "muted" }, "选择一个 session"));
      return;
    }
    const params = {
      assistantId: a.assistantId,
      sessionId: sessionState.active,
      limit: 100,
    };
    if (append && oldestCreatedAt) params.before = oldestCreatedAt;
    const resp = await api.get("/api/browse/conversations", params);
    const items = resp.items.slice().reverse();
    for (const t of items) {
      const bubble = el("div", { class: `bubble bubble--${t.role}` });
      const deleteBtn = el(
        "button",
        {
          class: "bubble-delete",
          title: "删除这条对话（含衍生记忆）",
          onclick: async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            // 直接删，不二次确认
            try {
              const r = await api.del(`/api/browse/conversation-turns/${encodeURIComponent(t.id)}`);
              bubble.remove();
              console.log("[delete]", t.id, r.deleted);
            } catch (e) {
              alert(`删除失败：${e.message || e}`);
            }
          },
        },
        "× 删除"
      );
      bubble.appendChild(
        el("div", { class: "bubble-meta" }, [
          el("strong", {}, t.role),
          " ",
          el("small", { class: "muted" }, formatTime(t.createdAt)),
          " ",
          el("small", { class: "muted mono", title: t.id }, t.id.slice(0, 8)),
          deleteBtn,
        ])
      );
      bubble.appendChild(el("div", { class: "bubble-content" }, t.content));
      if (append) right.insertBefore(bubble, right.firstChild);
      else right.appendChild(bubble);
    }
    if (resp.items.length) {
      oldestCreatedAt = resp.items[resp.items.length - 1].createdAt;
    }
    nextBefore = resp.nextBefore;
    const oldBtn = right.querySelector(".load-older-btn");
    if (oldBtn) oldBtn.remove();
    if (nextBefore) {
      const btn = el(
        "button",
        {
          class: "outline load-older-btn",
          onclick: () => loadStream(true),
        },
        "加载更早"
      );
      right.insertBefore(btn, right.firstChild);
    }
  }

  await loadStream();
}
