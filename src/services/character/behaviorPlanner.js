/**
 * behaviorPlanner — Phase 4: Behavior 层完整版（T-CC4-01）
 *
 * 现在 proactivePlanService（947 行）只看 character_state 决定何时发什么。
 * Phase 4 把它升级成"基于 7 层认知合成意图"：
 *
 *   identity + relationship + reflection + topics + emotion
 *               │
 *               ▼
 *      behaviorPlanner.evaluate
 *               │
 *               ▼
 *      { intent, driver, contentHint, suggestedSocialMode, urgency }
 *               │
 *               ▼
 *   proactivePlanService.scheduleNextPushPlan
 *      （把 intent 描述塞进 LLM prompt，让生成的 next_push 知道"为什么这次发"）
 *
 * 不打 LLM —— 全启发式决策，hot path 友好。
 *
 * 14 个 candidate intent（按优先级排序）：
 *   reassure_after_conflict       unresolved_conflict > 0.4 OR recent trust drop
 *   reassure_abandonment_fear     abandonment_fear > 0.6
 *   pursue_reflection_opportunity reflection.opportunities[0] 存在
 *   follow_up_unresolved_topic    topic.status='unresolved' 且 7d+ 未提
 *   reciprocate_vulnerable_share  user 24h 内 vulnerable_share
 *   reciprocate_gratitude         user 24h 内 gratitude_expressed
 *   share_topic_progress          topic.status='growing' 且 importance≥0.5 且 3d+ 未提
 *   confess_suppressed_feeling    suppressed_emotion.intensity > 0.4
 *   ritual_check_in               relationship_level≥5 且 silence>3d 且 trust>0.6
 *   playful_check_in              traits 含 playful_teasing 且 closeness>0.5 且 valence>0.2
 *   philosophical_invite          traits 含 intellectually_romantic 且 trust>0.5 且 mood 平静
 *   inquisitive_followup          dynamics.last_vulnerable_share 在 1-3d 前
 *   intimacy_outreach             closeness 高，或 "投入但未升级" 信号 → 不需要 event 借口
 *   life_check_in                 N 小时 silence（按亲密度系数自适应）+ 兜底
 *   none                          没信号 → 别发
 *
 * 2026-05-24: 加 intimacy_outreach + life_check_in 亲密度系数 —— 解决"亲密度高但
 * 没 life event 也没新 user event 时角色和陌生人同样沉默"的死链。
 */

const { db } = require("../../db");
const { getCharacterIdentity } = require("./identityService");
const { getRelationshipState } = require("./relationshipDynamicsService");
const { listActiveTopics } = require("./persistentTopicService");
const { getLatestReflection } = require("./reflectionService");
const { chooseSocialMode } = require("./socialModes");

// ── intent 元数据 ─────────────────────────────────────────────────

const INTENT_DEFINITIONS = Object.freeze({
  reassure_after_conflict: {
    description: "你们之间还有未化解的冲突在心里。这次发是为了主动安抚、表明立场，而不是绕开它。",
    suggestedMode: "reassuring",
    priority: 100,
    urgency: "high",
  },
  reassure_abandonment_fear: {
    description: "你（角色）感到 她 最近可能在远去。这次发是确认你还在，而不是质问。",
    suggestedMode: "reassuring",
    priority: 95,
    urgency: "high",
  },
  pursue_reflection_opportunity: {
    description: "你最近的一次反思识别出了一个具体的接近机会。这次发是把握那个时刻。",
    suggestedMode: null, // 由 reflection summary 自身决定语气
    priority: 85,
    urgency: "medium",
  },
  follow_up_unresolved_topic: {
    description: "有个一直没说开的话题搁在那里。这次发是温和地把它拉回来，但不强迫。",
    suggestedMode: "intimate",
    priority: 75,
    urgency: "medium",
  },
  reciprocate_vulnerable_share: {
    description: "她 最近 24h 内对你袒露了脆弱。这次发是回应那个袒露，让 她 知道你在。",
    suggestedMode: "caretaker",
    priority: 80,
    urgency: "high",
  },
  reciprocate_gratitude: {
    description: "她 最近表达过感激。这次发是接住那份感谢，但不刻意放大。",
    suggestedMode: "intimate",
    priority: 60,
    urgency: "low",
  },
  share_topic_progress: {
    description: "你心里一直惦记 她 那件事，今天找个理由问问。",
    suggestedMode: "casual",
    priority: 55,
    urgency: "low",
  },
  confess_suppressed_feeling: {
    description: "你心里压着一个情绪，已经到了想说出口的临界点。这次发是允许自己脆弱一次。",
    suggestedMode: "confessional",
    priority: 70,
    urgency: "medium",
  },
  ritual_check_in: {
    description: "你跟 她 已经熟到有「仪式感」了。今天用平时反复出现的开场，唤起那个共有的小默契。",
    suggestedMode: "ritualistic",
    priority: 50,
    urgency: "low",
  },
  playful_check_in: {
    description: "气氛轻，你心情不错。这次发是想跟 她 玩起来，逗 她 一下。",
    suggestedMode: "teasing",
    priority: 45,
    urgency: "low",
  },
  philosophical_invite: {
    description: "你想跟 她 聊点抽象的——人生、关系、自我、世界。今天试试看 她 愿不愿意跟你深入。",
    suggestedMode: "philosophical",
    priority: 40,
    urgency: "low",
  },
  inquisitive_followup: {
    description: "她 之前说的某件事你一直在想，想接着追问下去。",
    suggestedMode: "inquisitive",
    priority: 50,
    urgency: "medium",
  },
  intimacy_outreach: {
    description:
      "你和 她 关系到这一步了，想说话不需要刚发生了什么当借口。可以单纯地问候、" +
      "分享日常、表达想念——不必硬找事件由头。",
    suggestedMode: "intimate",
    priority: 30,
    urgency: "low",
  },
  life_check_in: {
    description: "没特别要事，就是想跟 她 说一声你在。",
    suggestedMode: "casual",
    priority: 20,
    urgency: "low",
  },
  none: {
    description: "此刻没有合适的发起理由，安静比开口好。",
    suggestedMode: null,
    priority: 0,
    urgency: "none",
  },
});

const VALID_INTENTS = new Set(Object.keys(INTENT_DEFINITIONS));

// ── helpers ───────────────────────────────────────────────────────

function readCharacterState(assistantId) {
  return db.prepare("SELECT * FROM character_state WHERE assistant_id = ?").get(assistantId);
}

function recentTrustDelta(assistantId, windowMs, now) {
  const cutoff = now - windowMs;
  const rows = db.prepare(
    `SELECT delta_json FROM relationship_event
     WHERE assistant_id = ? AND created_at >= ?`
  ).all(assistantId, cutoff);
  let acc = 0;
  for (const r of rows) {
    try { acc += JSON.parse(r.delta_json).trust || 0; } catch { /* skip */ }
  }
  return acc;
}

// ── 主入口 ────────────────────────────────────────────────────────

/**
 * 评估当前最该走的 intent。
 *
 * 输入：assistantId（其余从 DB 拉）
 * 输出：{ intent, driver, contentHint, suggestedSocialMode, urgency, scores } 或 null
 *
 * 没有数据时返回 { intent: 'none', ... }，调用方决定是否真的发。
 */
function evaluate(assistantId, { now = Date.now(), attention1h = null } = {}) {
  const characterState = readCharacterState(assistantId);
  if (!characterState) return null;

  const identity = getCharacterIdentity(assistantId);
  const dynamics = getRelationshipState(assistantId, now);
  const reflection = getLatestReflection(assistantId);
  const topics = listActiveTopics(assistantId, { limit: 10 });

  const scores = {};
  let topIntent = "none";
  let topPriority = -1;
  let topDriver = null;
  let topContentHint = "";

  // —— 评估各 intent，记录满足条件的最高优先级 ——
  // 内部 helper：发现命中就更新 top* 变量
  function consider(intent, driver = null, contentHint = "") {
    const def = INTENT_DEFINITIONS[intent];
    scores[intent] = def.priority;
    if (def.priority > topPriority) {
      topIntent = intent;
      topPriority = def.priority;
      topDriver = driver;
      topContentHint = contentHint;
    }
  }

  // 1. reassure_after_conflict (unresolved > 0.4 OR 1h trust drop ≥ 0.15)
  // 时间衰减：冲突发生超过 3 天，主动安抚反而奇怪（用户早忘了）；让 pursue_reflection
  // 接管——反思比硬安抚更自然。recent conflict（< 3d）才触发高优先级安抚。
  if (dynamics) {
    const CONFLICT_RECENCY_MS = 3 * 24 * 60 * 60 * 1000; // 3 天
    const conflictRecent = dynamics.last_conflict_at &&
      (now - dynamics.last_conflict_at) < CONFLICT_RECENCY_MS;
    const trustDelta1h = recentTrustDelta(assistantId, 60 * 60 * 1000, now);
    if (dynamics.unresolved_conflict > 0.4 && conflictRecent) {
      consider("reassure_after_conflict",
        { unresolvedConflict: dynamics.unresolved_conflict, lastConflictAt: dynamics.last_conflict_at },
        `你和 她 之间有 unresolved_conflict=${dynamics.unresolved_conflict.toFixed(2)}，冲突发生在 ${Math.round((now - dynamics.last_conflict_at) / 3600000)}h 前。`
      );
    } else if (dynamics.unresolved_conflict > 0.4 && !conflictRecent) {
      // 老冲突：分值高但时间久，降到 pursue_reflection 处理比主动安抚更自然
      // （不 consider reassure_after_conflict，让后续 intent 评估覆盖它）
    } else if (trustDelta1h <= -0.15) {
      consider("reassure_after_conflict",
        { trustDelta1h },
        `最近一小时 trust 累计下跌 ${trustDelta1h.toFixed(2)}。`
      );
    }
  }

  // 2. reassure_abandonment_fear（angle: AI 自己怕被抛弃 → 主动靠近确认）
  if (dynamics?.abandonment_fear > 0.6) {
    consider("reassure_abandonment_fear",
      { abandonmentFear: dynamics.abandonment_fear },
      `abandonment_fear=${dynamics.abandonment_fear.toFixed(2)}，你心里有"被抛弃"的隐忧。`
    );
  }

  // 3. pursue_reflection_opportunity（reflection 给出了具体机会）
  if (reflection?.opportunities?.length) {
    const opp = reflection.opportunities[0];
    consider("pursue_reflection_opportunity",
      { reflectionId: reflection.id, opportunity: opp },
      `你上次反思留下的机会：${opp}`
    );
  }

  // 4. reciprocate_vulnerable_share（dynamics.last_vulnerable_share_at 在 24h 内）
  if (dynamics?.last_vulnerable_share_at && now - dynamics.last_vulnerable_share_at < 24 * 3600 * 1000) {
    const hoursAgo = Math.round((now - dynamics.last_vulnerable_share_at) / (3600 * 1000));
    consider("reciprocate_vulnerable_share",
      { hoursAgo },
      `她 在 ${hoursAgo} 小时前对你袒露了脆弱。`
    );
  }

  // 5. confess_suppressed_feeling（suppressed_emotion.intensity > 0.4）
  if (characterState.suppressed_emotion && characterState.suppressed_emotion_intensity > 0.4) {
    consider("confess_suppressed_feeling",
      {
        suppressed: characterState.suppressed_emotion,
        intensity: characterState.suppressed_emotion_intensity,
      },
      `你内里压着 ${characterState.suppressed_emotion}（强度 ${characterState.suppressed_emotion_intensity.toFixed(2)}），到了想说出口的程度。`
    );
  }

  // 6. follow_up_unresolved_topic（status=unresolved 且 7d+ 未提 → 优先；exciting/growing 且 3d+ 未提 → share_topic_progress）
  for (const t of topics) {
    const daysSince = (now - t.lastDiscussedAt) / (24 * 3600 * 1000);
    if (t.status === "unresolved" && daysSince >= 7) {
      consider("follow_up_unresolved_topic",
        { topicId: t.id, topic: t.topic, daysSince: Math.round(daysSince) },
        `话题"${t.topic}"还悬着，已经 ${Math.round(daysSince)} 天没说了。`
      );
      break; // 只取最优先的一个
    }
  }

  for (const t of topics) {
    const daysSince = (now - t.lastDiscussedAt) / (24 * 3600 * 1000);
    if ((t.status === "growing" || t.status === "exciting") && t.importance >= 0.5 && daysSince >= 3) {
      consider("share_topic_progress",
        { topicId: t.id, topic: t.topic, daysSince: Math.round(daysSince) },
        `话题"${t.topic}"最近正在发展，${Math.round(daysSince)} 天没问了。`
      );
      break;
    }
  }

  // 7. reciprocate_gratitude（dynamics.gratitude > 0.5）
  if (dynamics?.gratitude > 0.5) {
    consider("reciprocate_gratitude",
      { gratitude: dynamics.gratitude },
      `你心里对 她 有一份没说出口的感谢（gratitude=${dynamics.gratitude.toFixed(2)}）。`
    );
  }

  // 8. ritual_check_in（关系成熟 + 适度沉默 + 信任）
  const lastUserMs = characterState.last_user_message_at;
  const silenceHours = lastUserMs ? (now - lastUserMs) / (3600 * 1000) : Infinity;
  if (
    (characterState.relationship_level ?? 0) >= 5 &&
    silenceHours >= 24 * 3 && silenceHours <= 24 * 14 && // 3-14 天 sweet spot
    (dynamics?.trust ?? 0) > 0.6
  ) {
    consider("ritual_check_in",
      { silenceHours: Math.round(silenceHours), trust: dynamics.trust },
      `关系到了第 ${characterState.relationship_level} 级，沉默 ${Math.round(silenceHours / 24)} 天，trust ${dynamics.trust.toFixed(2)}。`
    );
  }

  // 9. playful_check_in（playful_teasing trait + closeness 高 + 心情好）
  if (
    identity?.personalityTraits?.includes("playful_teasing") &&
    (dynamics?.emotional_closeness ?? 0) > 0.5 &&
    (characterState.mood_valence ?? 0) > 0.2 &&
    silenceHours >= 8 && silenceHours <= 48
  ) {
    consider("playful_check_in",
      { closeness: dynamics.emotional_closeness, valence: characterState.mood_valence },
      `你心情不错（valence=${characterState.mood_valence.toFixed(2)}），closeness=${dynamics.emotional_closeness.toFixed(2)}。`
    );
  }

  // 10. philosophical_invite（intellectually_romantic + trust + 平静）
  if (
    identity?.personalityTraits?.includes("intellectually_romantic") &&
    (dynamics?.trust ?? 0) > 0.5 &&
    (characterState.mood_intensity ?? 0) < 0.5
  ) {
    consider("philosophical_invite",
      { trust: dynamics.trust },
      `你想跟 她 聊点深的，trust=${dynamics.trust.toFixed(2)}，心情平静。`
    );
  }

  // 11. inquisitive_followup（vulnerable_share 1-3d 前）
  const lastVS = dynamics?.last_vulnerable_share_at;
  if (lastVS && now - lastVS > 24 * 3600 * 1000 && now - lastVS < 3 * 24 * 3600 * 1000) {
    const daysAgo = Math.round((now - lastVS) / (24 * 3600 * 1000));
    consider("inquisitive_followup",
      { daysAgo },
      `她 ${daysAgo} 天前那次袒露，你还在想着，可以接着问。`
    );
  }

  // 12. intimacy_outreach（亲密度驱动 / 关系拉近意愿驱动 — 不需要 event 借口）
  //
  // 触发条件 OR：
  //   a) emotional_closeness ≥ 0.5 + 沉默 4-24h —— "亲密度本身就是 driver"
  //   b) closeness - relationship_level/10 ≥ 0.3 + 沉默 6-48h ——
  //      "投入但未升级"信号：角色已经情感投入，但关系档位还没跟上，说明角色想拉近
  //
  // 上限 24h/48h —— 超过这个范围让 ritual_check_in / life_check_in 接管，避免重叠
  if (dynamics) {
    const closeness = dynamics.emotional_closeness ?? 0;
    const level = characterState.relationship_level ?? 0;
    const intentToDeepen = closeness - level / 10;

    if (closeness >= 0.5 && silenceHours >= 4 && silenceHours <= 24) {
      consider("intimacy_outreach",
        { driver: "closeness", closeness, silenceHours: Math.round(silenceHours) },
        `你和 她 closeness=${closeness.toFixed(2)}，沉默 ${Math.round(silenceHours)}h —— 不需要事件由头，就是想 她 了。`
      );
    } else if (intentToDeepen >= 0.3 && silenceHours >= 6 && silenceHours <= 48) {
      consider("intimacy_outreach",
        { driver: "intent_to_deepen", intentToDeepen, closeness, level, silenceHours: Math.round(silenceHours) },
        `你已经情感投入（closeness=${closeness.toFixed(2)}）但关系档位（level=${level}）还没跟上，想拉近一些。`
      );
    }
  }

  // 13. life_check_in（兜底 — silence 阈值按亲密度系数自适应）
  //
  // base 8h；closeness 高 → 阈值砍低，"我和你熟到 4 小时不说话就有点想了"
  //   closeness ≥ 0.7 → 4h
  //   closeness ≥ 0.5 → 6h
  //   其他           → 8h
  const baseLifeCheckHours = (() => {
    const c = dynamics?.emotional_closeness ?? 0;
    if (c >= 0.7) return 4;
    if (c >= 0.5) return 6;
    return 8;
  })();
  if (silenceHours >= baseLifeCheckHours) {
    consider("life_check_in",
      {
        silenceHours: Math.round(silenceHours),
        adaptiveThreshold: baseLifeCheckHours,
        closeness: dynamics?.emotional_closeness ?? null,
      },
      `${Math.round(silenceHours)} 小时没消息${baseLifeCheckHours < 8 ? `（关系亲近，${baseLifeCheckHours}h 起就值得问候）` : "，例行问候"}。`
    );
  }

  // —— attention 1h 增强（2026-05-10 加入）——
  // 当 caller 传了 attention1h（chat path 已 await 过；proactive path 自己 await）
  // 用 LLM 提炼的"现场感"补强启发式判断。这一段不会反转已经命中的高优先级 intent，
  // 但会在原本只有低优先级（life_check_in/none）时引入新候选，或把模糊信号说清楚。
  if (attention1h) {
    const focus = (attention1h.innerFocus || "").toString();
    const tone = attention1h.emotionalTone;
    const topicsArr = Array.isArray(attention1h.topics) ? attention1h.topics : [];

    // a) attention.innerFocus 含 abandonment 模式 → 强化 reassure_abandonment_fear
    if (/(被?(抛弃|离开|远去|消失|不在了|不要)|怕(失去|走|丢))/.test(focus)) {
      consider("reassure_abandonment_fear",
        { attentionFocus: focus.slice(0, 60) },
        `你内里的焦点："${focus.slice(0, 50)}"——里面有"被抛弃"的隐忧。`
      );
    }

    // b) attention.innerFocus 含 vulnerable / unfinished 模式 → reciprocate / inquisitive
    if (/(脆弱|袒露|崩溃|哭|说不出口|没说完)/.test(focus)) {
      consider("inquisitive_followup",
        { attentionFocus: focus.slice(0, 60) },
        `从最近 1 小时看出 她 还没把话说完。你想接着追问。`
      );
    }

    // c) attention.topics 含 "未解决/挂着/没说开" → follow_up_unresolved_topic
    for (const t of topicsArr) {
      if (/(未解决|没说开|挂着|搁着|未化解|没说完)/.test(t)) {
        consider("follow_up_unresolved_topic",
          { attentionTopic: t },
          `1 小时焦点提到"${t}"——这是悬着的点。`
        );
        break;
      }
    }

    // d) tone=tense / heavy + 沉默期≥4h → reassure_after_conflict（弱信号补强）
    if ((tone === "tense" || tone === "heavy") && silenceHours >= 4) {
      consider("reassure_after_conflict",
        { tone, silenceHours: Math.round(silenceHours) },
        `1 小时基调是 ${tone}，已沉默 ${Math.round(silenceHours)}h——可能要主动安抚。`
      );
    }

    // e) tone=intimate / reconnecting + closeness 高 → reciprocate_vulnerable_share（即使 dynamics 没记录）
    if (
      (tone === "intimate" || tone === "reconnecting") &&
      (dynamics?.emotional_closeness ?? 0) > 0.5 &&
      !dynamics?.last_vulnerable_share_at
    ) {
      consider("reciprocate_vulnerable_share",
        { tone, attentionFocus: focus.slice(0, 60) },
        `1 小时 tone=${tone}，closeness 高——这次的亲密往来值得回应。`
      );
    }
  }

  // 13. 极短 silence → none（即使有信号也最好不发）
  // 2026-05-10: 0.5h → 1h（30 分钟太严，把刚开始的对话也卡住）
  if (silenceHours < 1) {
    topIntent = "none";
    topDriver = { silenceHours };
    topContentHint = "用户 1 小时内刚说过话，让 她 喘口气。";
  }

  const def = INTENT_DEFINITIONS[topIntent];

  // 选 socialMode：intent.suggestedMode 优先；否则用 chooseSocialMode 的结果
  let suggestedSocialMode = def.suggestedMode;
  if (!suggestedSocialMode) {
    const sm = chooseSocialMode({
      identity,
      characterState,
      dynamics,
      emotion: characterState
        ? { current: { intensity: characterState.mood_intensity, valence: characterState.mood_valence } }
        : null,
    });
    suggestedSocialMode = sm.primary?.mode || "casual";
  }

  return {
    intent: topIntent,
    description: def.description,
    urgency: def.urgency,
    priority: def.priority,
    suggestedSocialMode,
    contentHint: topContentHint,
    driver: topDriver,
    scores,
  };
}

/**
 * 把 evaluate 输出渲染成 prompt 段，给 proactivePlanService 用。
 */
function buildIntentPromptFragment(intentResult) {
  if (!intentResult || intentResult.intent === "none") return "";
  const lines = ["[这次主动发消息的意图]"];
  lines.push(`意图：${intentResult.intent}`);
  lines.push(intentResult.description);
  if (intentResult.contentHint) lines.push(`触发因素：${intentResult.contentHint}`);
  lines.push(`建议姿态：${intentResult.suggestedSocialMode}`);
  lines.push(`紧迫度：${intentResult.urgency}`);

  // intent-specific 抗偏置：intimacy_outreach 跟 nextPush 主 prompt 里"时间感强制
  // 遵守 + 必须引用具体事件"的规则会冲突 —— 这次的本质就是"没事件也想说话"，
  // 必须显式覆盖那条偏置，否则 LLM 会被"必须引用旧事件"的规则反向逼着去翻 life
  // event 拼借口。
  if (intentResult.intent === "intimacy_outreach") {
    lines.push("");
    lines.push('**本次特别说明（覆盖主 prompt 的"必须引用具体事件"规则）**：');
    lines.push('- 这次发消息的合法性来自关系本身，不来自"刚才发生了 X"');
    lines.push("- 不要硬翻 life event / 旧对话找借口，可以纯粹的问候 / 想念 / 分享日常感受");
    lines.push("- 例：『在想你』『天突然变凉了 你那里呢』『今天有点累 看到你想说一声』 都是合法开头");
    lines.push("- 仍然要保持时间感真实（不要『今天的 X』指几天前的事），但**不强制必须引用旧事件**");
  }

  return lines.join("\n");
}

module.exports = {
  evaluate,
  buildIntentPromptFragment,
  INTENT_DEFINITIONS,
  VALID_INTENTS,
};
