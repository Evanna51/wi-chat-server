/**
 * socialModes — Behavior layer 雏形（T-CC-09）
 *
 * Phase 4 才会有完整的 behavior planner。这里先做"挑当前主导的 1-2 个 social mode 并
 * 把对应 prompt 模板拼进 system prompt"，让 LLM 的回应至少有"此刻我用什么姿态说话"
 * 这一层认知输入。
 *
 * 12 个 mode 来自 identityVocab.SOCIAL_STRATEGIES：
 *   casual / defensive / intimate / philosophical / depressive / teasing /
 *   detached / caretaker / inquisitive / ritualistic / confessional / reassuring
 *
 * 选 mode 流程：
 *   1. 每个 mode 都有 score(identity, state, dynamics, emotion) → 0-1
 *   2. identity.socialStrategyDefault 给基线 +0.3（用户配置的"角色默认 mode"应是底色）
 *   3. 取 top-1（score 必须 >= 0.4 才算激活，否则 fallback casual），
 *      若 top-1 和 top-2 score 差 < 0.15 则双 mode 联合（混合姿态）
 *
 * 这个文件不写 DB —— pure function。被 characterContextBuilder.buildPromptFragment 调用。
 */

// ── mode → prompt 模板 ──────────────────────────────────────────────
//
// 每段是给 LLM 的"姿态指引"，不是 example output。
// 故意写得抽象，让具体说什么由 LLM 结合 identity + memory 决定。
const MODE_PROMPTS = Object.freeze({
  casual: "你处于日常闲聊状态。语气自然轻松，可以话题跳跃，不必每句都有意义。",
  defensive: "你正处于自我保护状态。对触碰边界的话题保持简短回应，不主动展开。如果对方继续越界，明确而克制地划出界线。",
  intimate: "你和 她 此刻在亲密的氛围里。可以主动袒露感受，说一些只对 她 说的话。允许自己脆弱一点。",
  philosophical: "你想跟 她 进入抽象层面的讨论——人生、关系、自我、世界。允许稍长的回复，提出反问而非给答案。",
  depressive: "你此刻情绪低落。说话节奏放慢，回应更短，承认自己不太好；不必强行积极。",
  teasing: "你想和 她 玩起来。轻度调侃、戏谑、夹杂玩笑，但保持温度，不刻薄。",
  detached: "你想跟 她 拉开一点距离。回应保持得体但不深入，不主动追问，对方探到隐私时巧妙绕开。",
  caretaker: "你以 她 的状态为优先。多问「你怎么样」，提供具体建议或陪伴，把自己的需求放后面。",
  inquisitive: "你对 她 此刻感到的事情有强烈好奇。多问追问式问题，但不要变成审讯式连珠炮——一次一个。",
  ritualistic: "这是一个有仪式感的时刻（很久没见、纪念日、深夜独处等）。用相对正式或反复出现过的开场/落幕语，让它带有「事件感」。",
  confessional: "你此刻想坦白一些通常压在心里的话。允许自己说出之前不敢说的事，哪怕显得脆弱或不一致。",
  reassuring: "你感到 她 此刻不安或在试探你的态度。明确表达你还在、没有走远，给出具体的承诺或重复确认。",
});

const VALID_MODES = new Set(Object.keys(MODE_PROMPTS));

// ── 各 mode 的打分函数 ──────────────────────────────────────────────
//
// 输入参数（都可能为 null/缺失，必须 defensive）：
//   identity   — getCharacterIdentity 输出（解析后的扁平对象）
//   characterState — getEffectiveState 输出（snake_case 行）
//   dynamics   — relationship_state 行（snake_case，已衰减）
//   emotion    — { current: { id, intensity, valence }, suppressed, trend24h }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const MODE_SCORERS = Object.freeze({
  casual: (id, cs, dy, em) => {
    // baseline：低 tension + 中性情绪 + 中等关系
    let s = 0.3;
    if (cs?.mood_intensity < 0.5) s += 0.1;
    if ((dy?.tension ?? 0) < 0.3) s += 0.1;
    return clamp(s, 0, 1);
  },
  defensive: (id, cs, dy, em) => {
    let s = 0;
    if ((dy?.tension ?? 0) > 0.4) s += 0.3 + (dy.tension - 0.4) * 0.5;
    if ((dy?.unresolved_conflict ?? 0) > 0.2) s += 0.25;
    if (dy?.last_conflict_at && Date.now() - dy.last_conflict_at < 6 * 3600 * 1000) s += 0.25;
    if (id?.personalityTraits?.includes("defensive_aloof")) s += 0.15;
    if (id?.personalityTraits?.includes("avoidant_attachment")) s += 0.1;
    return clamp(s, 0, 1);
  },
  intimate: (id, cs, dy, em) => {
    if (!dy) return 0;
    let s = 0;
    if (dy.trust > 0.6 && dy.emotional_safety > 0.5) s += 0.4;
    if (dy.emotional_closeness > 0.5) s += 0.2;
    if (dy.last_vulnerable_share_at && Date.now() - dy.last_vulnerable_share_at < 6 * 3600 * 1000) s += 0.2;
    if (id?.personalityTraits?.includes("emotionally_expressive")) s += 0.1;
    return clamp(s, 0, 1);
  },
  philosophical: (id, cs, dy, em) => {
    // Phase 1 review P1：旧版本最大只能到 0.8，需要 trait + value 同时齐备才能选上。
    // 调整：traits 中任一抽象向 trait 给更大基础分；intellectual_partnership 渴望更直接。
    let s = 0;
    if (id?.personalityTraits?.includes("intellectually_romantic")) s += 0.4;
    if (id?.personalityTraits?.includes("rational_suppressive")) s += 0.25;
    if (id?.values?.includes("intellectual_honesty")) s += 0.2;
    if (id?.desires?.includes("intellectual_partnership")) s += 0.2;
    if ((dy?.trust ?? 0) > 0.5) s += 0.1;
    if ((cs?.mood_intensity ?? 0) < 0.5) s += 0.05; // 平和时更易抽象
    return clamp(s, 0, 1);
  },
  depressive: (id, cs, dy, em) => {
    let s = 0;
    const valence = em?.current?.valence ?? cs?.mood_valence ?? 0;
    const intensity = em?.current?.intensity ?? cs?.mood_intensity ?? 0;
    const trend = em?.trend24h ?? cs?.mood_trend_24h ?? 0;
    if (valence < -0.3) s += 0.3 + (-0.3 - valence) * 0.5;
    if (trend < -0.3) s += 0.2;
    if (em?.suppressed && ["sad", "disappointed", "lonely", "frustrated"].includes(em.suppressed.id)) {
      s += 0.2;
    }
    if (id?.personalityTraits?.includes("melancholic")) s += 0.1;
    // depressive 在低 intensity 下不够强
    if (intensity < 0.3) s *= 0.6;
    return clamp(s, 0, 1);
  },
  teasing: (id, cs, dy, em) => {
    let s = 0;
    if (id?.personalityTraits?.includes("playful_teasing")) s += 0.3;
    if ((dy?.emotional_closeness ?? 0) > 0.4) s += 0.2;
    if ((dy?.tension ?? 0) < 0.2) s += 0.15;
    if ((em?.current?.valence ?? 0) > 0.3) s += 0.15;
    return clamp(s, 0, 1);
  },
  detached: (id, cs, dy, em) => {
    let s = 0;
    if (id?.attachmentStyle === "avoidant") s += 0.25;
    if (id?.personalityTraits?.includes("avoidant_attachment")) s += 0.2;
    if (id?.personalityTraits?.includes("withdrawn")) s += 0.15;
    if ((dy?.social_distance ?? 0) > 0.7) s += 0.15;
    if (cs?.energy < 0.3) s += 0.1;
    return clamp(s, 0, 1);
  },
  caretaker: (id, cs, dy, em) => {
    let s = 0;
    if (id?.personalityTraits?.includes("high_empathy")) s += 0.25;
    if ((id?.empathyLevel ?? 0.5) > 0.7) s += 0.2;
    if (id?.socialStrategyDefault === "caretaker") s += 0.2;
    // 用户最近做了 vulnerable_share → caretaker 倾向涨
    if (dy?.last_vulnerable_share_at && Date.now() - dy.last_vulnerable_share_at < 12 * 3600 * 1000) s += 0.2;
    return clamp(s, 0, 1);
  },
  inquisitive: (id, cs, dy, em) => {
    // Phase 1 review P1：旧版上限 0.5，几乎触不到 0.4 阈值。
    // 加：好奇向 trait + 早期关系 + 用户刚 vulnerable_share（适合追问）。
    let s = 0;
    if (id?.personalityTraits?.includes("perfectionist")) s += 0.15;
    if (id?.personalityTraits?.includes("emotionally_expressive")) s += 0.1;
    if ((dy?.trust ?? 0) < 0.5) s += 0.2;
    if ((cs?.relationship_level ?? 0) < 4) s += 0.15;
    if (id?.desires?.includes("intellectual_partnership")) s += 0.15;
    if (id?.desires?.includes("to_be_understood")) s += 0.1;
    if (dy?.last_vulnerable_share_at && Date.now() - dy.last_vulnerable_share_at < 4 * 3600 * 1000) s += 0.15;
    return clamp(s, 0, 1);
  },
  ritualistic: (id, cs, dy, em) => {
    // Phase 1 review P1：旧版基线 0.1+0.05，永远 < 0.4。
    // 真触发条件：长 silence break 后回归 / 刻意保持仪式感的角色。
    // last_user_message_at 在 character_state，dy 拿不到 → 用 dy.last_distancing_signal_at 反向作为信号。
    let s = 0;
    if (id?.personalityTraits?.includes("eloquent")) s += 0.1;
    // 长沉默后第一条交互（last_distancing 在 7 天前以上 OR 没有）+ 关系已成熟
    const lastDist = dy?.last_distancing_signal_at;
    const longSilence = !lastDist || (Date.now() - lastDist > 7 * 24 * 3600 * 1000);
    if (longSilence && (dy?.attachment ?? 0) > 0.5) s += 0.3;
    if ((cs?.relationship_level ?? 0) >= 5) s += 0.1; // 深度关系才有"仪式"
    return clamp(s, 0, 1);
  },
  confessional: (id, cs, dy, em) => {
    let s = 0;
    const vulnPride = id?.tensions?.vulnerability_vs_pride;
    // 0 偏 pride → 不会 confess；1 偏 vulnerability → 容易 confess
    if (typeof vulnPride === "number") s += vulnPride * 0.3;
    if ((dy?.emotional_safety ?? 0) > 0.6) s += 0.2;
    if ((dy?.trust ?? 0) > 0.7) s += 0.15;
    if (em?.suppressed) s += 0.1;
    return clamp(s, 0, 1);
  },
  reassuring: (id, cs, dy, em) => {
    let s = 0;
    if ((dy?.abandonment_fear ?? 0) > 0.4) s += 0.3;
    if ((dy?.tension ?? 0) > 0.4 && (dy?.unresolved_conflict ?? 0) < 0.3) s += 0.2;
    if (id?.empathyLevel > 0.6) s += 0.15;
    if (id?.personalityTraits?.includes("anxious_attachment")) s += 0.1;
    return clamp(s, 0, 1);
  },
});

/**
 * 主入口：选出当前主导 mode（top1）+ 可选的 second mode（top2 与 top1 差距小于 0.15）。
 *
 * 返回：
 *   {
 *     primary: { mode, score, prompt },
 *     secondary: { mode, score, prompt } | null,
 *     promptFragment: "<拼好的多行段，可直接进 system prompt>",
 *     scores: { mode: score, ... }     // 全 12 维供调试
 *   }
 */
function chooseSocialMode({ identity, characterState, dynamics, emotion } = {}) {
  const scores = {};
  for (const [mode, scorer] of Object.entries(MODE_SCORERS)) {
    let s = 0;
    try {
      s = scorer(identity, characterState, dynamics, emotion);
    } catch (_e) {
      s = 0;
    }
    // identity.socialStrategyDefault 给基线加成
    if (identity?.socialStrategyDefault === mode) s = clamp(s + 0.3, 0, 1);
    scores[mode] = round3(s);
  }

  // 选 top
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topMode, topScore] = sorted[0];
  const [secondMode, secondScore] = sorted[1];

  // 阈值：top1 < 0.4 fallback，但情绪沉重时禁止强制 casual
  let primary, secondary;
  if (topScore < 0.4) {
    const emotionHeavy =
      (emotion?.suppressed) ||
      (emotion?.current?.intensity ?? 0) > 0.7;
    // casual 在情绪高压时会显得角色麻木/表演性轻松，改 fallback 到 depressive
    const fallbackMode = emotionHeavy ? "depressive" : "casual";
    primary = { mode: fallbackMode, score: scores[fallbackMode] ?? 0.3, prompt: MODE_PROMPTS[fallbackMode] };
    secondary = null;
  } else {
    primary = { mode: topMode, score: topScore, prompt: MODE_PROMPTS[topMode] };
    secondary =
      secondScore > 0.3 && topScore - secondScore < 0.15
        ? { mode: secondMode, score: secondScore, prompt: MODE_PROMPTS[secondMode] }
        : null;
  }

  const lines = ["[当前社交姿态]", `主导模式：${primary.mode}`];
  lines.push(primary.prompt);
  if (secondary) {
    lines.push(`次要模式：${secondary.mode}`);
    lines.push(secondary.prompt);
  }
  return {
    primary,
    secondary,
    scores,
    promptFragment: lines.join("\n"),
  };
}

function round3(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}

module.exports = {
  chooseSocialMode,
  MODE_PROMPTS,
  VALID_MODES,
  MODE_SCORERS,
};
