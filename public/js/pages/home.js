import { api } from "../api.js";
import { el, clearRoot } from "../el.js";
import { formatBytes, isCharacterTypeLike, assistantTypeLabel } from "../utils.js";
import { state } from "../state.js";

export async function viewHome() {
  const container = clearRoot();
  container.appendChild(el("article", { "aria-busy": "true" }, "加载主页…"));

  let assistantsResp;
  let statsResp;
  let configResp;
  try {
    [assistantsResp, statsResp, configResp] = await Promise.all([
      api.get("/api/browse/assistants"),
      api.get("/api/browse/stats"),
      api.get("/api/browse/config"),
    ]);
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("article", {}, [
      el("h3", {}, "加载失败"),
      el("pre", {}, err.message),
    ]));
    return;
  }
  state.stats = statsResp;

  container.innerHTML = "";

  const stats = statsResp;
  const totalRows = Object.values(stats.tables || {})
    .filter((n) => typeof n === "number")
    .reduce((a, b) => a + b, 0);

  const summary = el("article", { class: "summary-card" }, [
    el("header", {}, [el("strong", {}, "服务概况")]),
    el("div", { class: "summary-grid" }, [
      el("div", {}, [
        el("small", {}, "DB 大小"),
        el("div", { class: "metric" }, formatBytes(stats.db.sizeBytes)),
      ]),
      el("div", {}, [
        el("small", {}, "总行数"),
        el("div", { class: "metric" }, String(totalRows)),
      ]),
      el("div", {}, [
        el("small", {}, "对话"),
        el("div", { class: "metric" }, String(stats.tables.conversation_turns ?? 0)),
      ]),
      el("div", {}, [
        el("small", {}, "记忆"),
        el("div", { class: "metric" }, String(stats.tables.memory_items ?? 0)),
      ]),
      el("div", {}, [
        el("small", {}, "行为日志"),
        el("div", { class: "metric" }, String(stats.tables.character_behavior_journal ?? 0)),
      ]),
    ]),
  ]);
  container.appendChild(summary);

  const wsMap = stats.wsActiveSockets || {};
  const wsEntries = Object.entries(wsMap);
  const wsRowChildren = wsEntries.length
    ? wsEntries.map(([uid, n]) =>
        el("span", { class: "badge badge--neutral" }, `${uid}: ${n}`)
      )
    : [el("span", { class: "muted" }, "(none)")];
  const wsBlock = el("article", {}, [
    el("header", {}, [el("strong", {}, "WS 在线设备数")]),
    el("div", { class: "badge-row" }, wsRowChildren),
  ]);
  container.appendChild(wsBlock);

  const list = assistantsResp.assistants || [];
  const grid = el("section", { class: "card-grid" });
  if (!list.length) {
    grid.appendChild(el("article", {}, "暂无角色，调用 /api/assistant-profile/upsert 创建一个再回来。"));
  }
  for (const a of list) {
    const cardIsChar = isCharacterTypeLike(a.assistantType);

    // 头部：name + id + ghost tags（类型 / 熟悉度，所有 type 都有）
    const ghostTags = el("div", { class: "ghost-tag-row" }, [
      el("span", { class: "ghost-tag", title: "assistant_type" },
        `类型 · ${assistantTypeLabel(a.assistantType)}`),
      el("span", { class: "ghost-tag", title: "familiarity" },
        `熟悉度 · ${a.state?.familiarity ?? 0}/100`),
    ]);

    // 中部：自驱开关（仅 character 类型）—— 非 character 时这区域占位以保持高度
    const togglesRow = cardIsChar
      ? el("div", { class: "card-toggles" }, [
          el("span", {
            class: `badge ${a.allowAutoLife ? "badge--on" : "badge--off"}`,
            title: "allow_auto_life",
          }, `自驱生活: ${a.allowAutoLife ? "on" : "off"}`),
          el("span", {
            class: `badge ${a.allowProactiveMessage ? "badge--on" : "badge--off"}`,
            title: "allow_proactive_message",
          }, `主动消息: ${a.allowProactiveMessage ? "on" : "off"}`),
        ])
      : el("div", { class: "card-toggles card-toggles--placeholder" },
          el("span", { class: "muted small" }, "（非人物类型，无自驱配置）"));

    const card = el("article", { class: "char-card" }, [
      el("header", { class: "char-card__head" }, [
        el("strong", { class: "char-card__name" }, a.characterName || a.assistantId),
        el("small", { class: "char-card__id" }, a.assistantId),
        ghostTags,
      ]),
      el("div", { class: "char-card__body" }, [
        togglesRow,
        el("div", { class: "char-card__counts" }, [
          el("span", {}, `对话 ${a.counts.conversationTurns}`),
          el("span", {}, `记忆 ${a.counts.memoryItems}`),
          el("span", {}, `行为 ${a.counts.journalEntries}`),
        ]),
      ]),
      el("footer", { class: "char-card__foot" }, [
        el("a", {
          href: `#/character/${encodeURIComponent(a.assistantId)}`,
          role: "button",
          class: "char-card__enter",
        }, "查看"),
      ]),
    ]);
    grid.appendChild(card);
  }
  container.appendChild(grid);

  const cfg = configResp.config;
  const cfgBlock = el("article", { class: "config-block" }, [
    el("header", {}, [el("strong", {}, "调度与全局配置（只读）")]),
    el("dl", { class: "config-dl" }, [
      el("dt", {}, "life cron"),
      el("dd", {}, cfg.lifeMemoryCron),
      el("dt", {}, "proactive cron"),
      el("dd", {}, cfg.proactiveMessageCron),
      el("dt", {}, "retention cron"),
      el("dd", {}, cfg.retentionSweepCron),
      el("dt", {}, "dryRun（默认）"),
      el("dd", {}, String(cfg.autonomousDryRun)),
      el("dt", {}, "push enabled"),
      el("dd", {}, String(cfg.autonomousPushEnabled)),
      el("dt", {}, "quiet hours"),
      el("dd", {}, cfg.autonomousQuietHours),
      el("dt", {}, "timezone"),
      el("dd", {}, cfg.timezone),
    ]),
  ]);
  container.appendChild(cfgBlock);
}
