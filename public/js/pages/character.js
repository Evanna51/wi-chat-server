import { api } from "../api.js";
import { el, clearRoot } from "../el.js";
import { isCharacterTypeLike, assistantTypeLabel } from "../utils.js";

const TABS = [
  { id: "overview", label: "概览" },
  { id: "manage", label: "角色设定" },
  { id: "conversation", label: "对话" },
  { id: "cognition", label: "认知" },
  { id: "intent", label: "意图" },
  { id: "memory", label: "记忆" },
  { id: "facts", label: "事实" },
  { id: "journal", label: "行为日志" },
];

// 模块级缓存：同一 assistantId 在 tab 间切换时复用，避免重复 fetch
let cachedAssistant = null;
let cachedId = null;

export async function viewCharacter(assistantId, tabId = "overview") {
  const container = clearRoot();

  // 复用缓存还是重新拉
  let a;
  if (cachedId === assistantId && cachedAssistant) {
    a = cachedAssistant;
  } else {
    container.appendChild(el("article", { "aria-busy": "true" }, "加载角色…"));
    let resp;
    try {
      resp = await api.get(`/api/browse/assistants/${encodeURIComponent(assistantId)}`);
    } catch (err) {
      container.innerHTML = "";
      container.appendChild(el("article", {}, [
        el("h3", {}, "未找到角色"),
        el("pre", {}, err.message),
        el("a", { href: "#/" }, "返回主页"),
      ]));
      cachedAssistant = null;
      cachedId = null;
      return;
    }
    a = resp.assistant;
    cachedAssistant = a;
    cachedId = assistantId;
  }

  container.innerHTML = "";

  const isCharacterLike = isCharacterTypeLike(a.assistantType);
  const badges = [];
  badges.push(el("span", { class: "badge badge--neutral" }, `类型: ${assistantTypeLabel(a.assistantType)}`));
  if (isCharacterLike) {
    badges.push(
      el(
        "span",
        { class: `badge ${a.allowAutoLife ? "badge--on" : "badge--off"}` },
        `自驱生活: ${a.allowAutoLife ? "on" : "off"}`
      )
    );
    badges.push(
      el(
        "span",
        { class: `badge ${a.allowProactiveMessage ? "badge--on" : "badge--off"}` },
        `主动消息: ${a.allowProactiveMessage ? "on" : "off"}`
      )
    );
  }
  badges.push(el("span", { class: "badge badge--neutral" }, `轮次: ${a.state?.totalTurns ?? 0}`));

  const head = el("section", { class: "char-head" }, [
    el("h2", {}, a.characterName || a.assistantId),
    el("small", { class: "muted mono" }, a.assistantId),
    el("div", { class: "badge-row" }, badges),
  ]);
  container.appendChild(head);

  const tabBar = el("nav", { class: "tab-bar" });
  const tabUl = el("ul");
  for (const t of TABS) {
    const link = el(
      "a",
      {
        href: `#/character/${encodeURIComponent(assistantId)}/${t.id}`,
        class: t.id === tabId ? "tab-active" : "",
      },
      t.label
    );
    tabUl.appendChild(el("li", {}, [link]));
  }
  tabBar.appendChild(tabUl);
  container.appendChild(tabBar);

  const body = el("section", { id: "tab-body" });
  container.appendChild(body);

  // 按 tab 动态 import 对应 render 函数
  if (tabId === "overview") {
    const m = await import("./character-overview.js");
    return m.renderOverviewTab(body, a);
  }
  if (tabId === "conversation") {
    const m = await import("./character-conversation.js");
    return m.renderConversationTab(body, a);
  }
  if (tabId === "memory") {
    const m = await import("./character-memory.js");
    return m.renderMemoryTab(body, a);
  }
  if (tabId === "journal") {
    const m = await import("./character-journal.js");
    return m.renderJournalTab(body, a);
  }
  if (tabId === "facts") {
    const m = await import("./character-facts.js");
    return m.renderFactsTab(body, a);
  }
  if (tabId === "cognition") {
    const m = await import("./character-cognition.js");
    return m.renderCognitionTab(body, a);
  }
  if (tabId === "intent") {
    const m = await import("./character-intent.js");
    return m.renderIntentTab(body, a);
  }
  if (tabId === "manage") {
    const m = await import("./character-settings.js");
    return m.renderManageTab(body, a);
  }
}
