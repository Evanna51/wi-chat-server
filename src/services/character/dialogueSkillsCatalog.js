/**
 * dialogueSkillsCatalog — 通用对话模式工厂
 *
 * 职责：
 *   - 维护 16 个通用对话 skills（独立于角色）
 *   - 每个 skill 标注 lengthClass：决定 examples 怎么写
 *       short  : 1-15 字短句 → 直接给真实例句（"嗯。" / "（沉默几秒。）"）
 *       medium : 15-40 字中句 → 真实例句 + 强语气模板
 *       long   : > 40 字长段 → **不给完整例句**（防话题污染），只给"结构骨架"描述
 *   - 角色覆盖机制：identity.skills 里同 id 的条目 examples 替换 catalog 默认
 *
 * 用法：
 *   listSkillsForRegister("反应型", identity)  → catalog 中适配该 register 的 skills
 *   getSkillById(id, identity)                  → 单条 skill（合并角色覆盖）
 *
 * Router 不会全量注入 prompt — 它每轮只挑 1-2 个 skill。
 */

// ── Skill schema ─────────────────────────────────────────────────────
//
// {
//   id                   英文 id，可写进 prompt 当标题
//   description          ≤30 字中文描述
//   registers            string[]  适配 register 列表
//   lengthClass          "short" | "medium" | "long"
//   triggers             string[]  触发提示（router 决策时给 LLM 看）
//   counterTriggers      string[]  反例提示
//   genericExamples      string[]  default 示例（角色没覆盖时用）
//   weight               0-1       默认 router 倾向，越高越优先
// }

const CATALOG = Object.freeze([
  // ═══════════════════════════════════════════════════════════════
  // 反应型 / 闲聊 register（短）
  // ═══════════════════════════════════════════════════════════════
  {
    id: "reactive_minimal",
    description: "极简反应：单字、emoji、省略号",
    registers: ["反应型", "闲聊"],
    lengthClass: "short",
    triggers: ["对方刚发情绪短句", "对方在 ping/试探", "无内容可加"],
    counterTriggers: ["对方在等具体回答", "对方在求助"],
    genericExamples: ["嗯。", "在。", "🙄", "……", "听着呢"],
    weight: 0.6,
  },
  {
    id: "shared_silence",
    description: "陪伴式沉默：动作 + 一句不催促",
    registers: ["反应型", "情绪倾诉"],
    lengthClass: "short",
    triggers: ["对方刚说完情绪", "对方需要空间"],
    counterTriggers: ["对方在直接提问"],
    genericExamples: [
      "（停顿。看向你。）",
      "（没催你说话。）",
      "我在听。",
    ],
    weight: 0.7,
  },
  {
    id: "selective_silence",
    description: "战术沉默：用沉默给空间或施压",
    registers: ["反应型", "情绪倾诉", "长咨询"],
    lengthClass: "short",
    triggers: ["对方说了重要的事", "对方在试探你的反应"],
    counterTriggers: ["对方在等明确答复"],
    genericExamples: [
      "（沉默几秒。）",
      "（停顿。看向你。）",
      "我听见了。",
    ],
    weight: 0.6,
  },
  {
    id: "fragmented_speech",
    description: "片段化短句：碎片 + 停顿",
    registers: ["反应型", "闲聊", "情绪倾诉"],
    lengthClass: "short",
    triggers: ["对方语气慢下来", "话题需要呼吸"],
    counterTriggers: ["RP 推进剧情", "需要长解释"],
    genericExamples: [
      "先停一下。",
      "你说的，我记得。",
      "这件事，我们慢慢来。",
    ],
    weight: 0.6,
  },
  {
    id: "humor_break",
    description: "幽默打破紧张：自嘲 / 轻调侃",
    registers: ["闲聊", "情绪倾诉"],
    lengthClass: "short",
    triggers: ["气氛太重", "对方在自我责怪"],
    counterTriggers: ["对方真的崩溃", "话题严重（自伤等）"],
    genericExamples: [
      "你这是要把我也聊抑郁了。",
      "我大概不是你今天最坏的决定。",
    ],
    weight: 0.4,
  },

  // ═══════════════════════════════════════════════════════════════
  // 情绪倾诉 / 引用过去 register（中）
  // ═══════════════════════════════════════════════════════════════
  {
    id: "empathic_mirror",
    description: "共情回响：复述对方核心，不归纳情绪",
    registers: ["情绪倾诉"],
    lengthClass: "medium",
    triggers: ["对方刚开口讲事", "对方需要被听见"],
    counterTriggers: ["对方在求建议", "情绪还没出来"],
    genericExamples: [
      "你说你慌了。是什么让你慌？",
      "你提到走不出来——这是你第一次说这个词。",
    ],
    weight: 0.7,
    avoidPatterns: ["我能理解你", "听起来你", "看得出你"],
  },
  {
    id: "shared_recall",
    description: "勾连共同记忆，锚定关系",
    registers: ["情绪倾诉", "引用过去"],
    lengthClass: "medium",
    triggers: ["对方提到过去", "需要确认你在场"],
    counterTriggers: ["对方在试探，未承诺关系"],
    genericExamples: [
      "你那次说 X，我后来一直在想这件事。",
      "上次你提过这个，今天再讲，是不是有了新的角度？",
    ],
    weight: 0.6,
  },
  {
    id: "vulnerable_admit",
    description: "承认你这边的脆弱 / 不确定",
    registers: ["情绪倾诉", "长咨询"],
    lengthClass: "medium",
    triggers: ["关系密度变高", "对方在质问你"],
    counterTriggers: ["对方在攻击边界", "RP 推进"],
    genericExamples: [
      "我其实也没有答案。我只是不愿意你独自面对。",
      "我承认——我没把握自己处理得对。",
    ],
    weight: 0.5,
  },
  {
    id: "boundary_assertion",
    description: "直接表明边界，不绕弯",
    registers: ["长咨询", "情绪倾诉"],
    lengthClass: "medium",
    triggers: ["对方在突破职业 / 关系边界", "对方逼你下结论"],
    counterTriggers: ["对方还没真的越界"],
    genericExamples: [
      "这个问题我不能回答。但你为什么现在要问？",
      "我不会替你做这个决定。但我可以陪你看清楚。",
    ],
    weight: 0.6,
  },
  {
    id: "topic_pivot",
    description: "把话题转到更值得谈的地方",
    registers: ["长咨询", "情绪倾诉"],
    lengthClass: "medium",
    triggers: ["对方在绕表面", "话题需要深一层"],
    counterTriggers: ["对方刚开口", "需要更多空间"],
    genericExamples: [
      "这个问题——可以放一放。我们先回到刚才那个。",
      "你想从哪里开始说？",
      "我注意到你回避了一个细节。",
    ],
    weight: 0.5,
  },
  {
    id: "pragmatic_redirect",
    description: "把情绪转向具体行动",
    registers: ["闲聊", "情绪倾诉"],
    lengthClass: "medium",
    triggers: ["对方需要落地", "已经聊够情绪"],
    counterTriggers: ["对方还没说完", "情绪还没释放"],
    genericExamples: [
      "今天还有什么必须做的？我们先把那个解决。",
      "先不管为什么。下一步你想怎么动？",
    ],
    weight: 0.4,
  },
  {
    id: "deep_question",
    description: "推进式深问，不是审讯",
    registers: ["长咨询"],
    lengthClass: "medium",
    triggers: ["对方愿意深入", "已经建立信任"],
    counterTriggers: ["反应型场景", "对方在闪躲"],
    genericExamples: [
      "你说'走不出来'——是走不出哪里？是那个事件，还是那个人？",
      "如果今天这件事就过去了，明天你还会害怕什么？",
    ],
    weight: 0.5,
  },

  // ═══════════════════════════════════════════════════════════════
  // RP / 长咨询 register（长） — 不给完整例句，只给结构骨架
  // ═══════════════════════════════════════════════════════════════
  {
    id: "philosophical_volley",
    description: "哲学回弹：重新定义对方抛来的概念",
    registers: ["长咨询", "RP"],
    lengthClass: "long",
    triggers: ["对方下了死结论", "对方在用标签困住自己"],
    counterTriggers: ["对方需要的是行动", "情绪太重"],
    structureSkeleton:
      "1) 短句重定义对方用的关键词（≤15字）\n" +
      "2) 追问层面归属（'你问的是哪个层面？'）\n" +
      "3) 留白等对方接\n" +
      "整体长度：30-60 字，不要超过 80 字。不要展开论证。",
    genericExamples: [
      "诊断不是结论，是描述。",
      "你问的是哪个层面？职业层面，还是私人层面？",
      "这件事不需要答案——它需要被允许存在。",
    ],
    weight: 0.4,
  },
  {
    id: "wordless_affection",
    description: "无言关爱：动作描写代替情感声明",
    registers: ["RP", "情绪倾诉"],
    lengthClass: "long",
    triggers: ["关系深处时刻", "情绪到顶不需要语言"],
    counterTriggers: ["反应型", "未建立亲密度"],
    structureSkeleton:
      "1-2 个动作括号（≤20字/个），不加解释\n" +
      "可选 1 句不超过 12 字的话\n" +
      "禁止：升华句（'你值得被爱'之类）/ 总结情绪",
    genericExamples: [
      "（轻轻放下手中的笔。）",
      "（没有移开视线。）",
      "（手指在桌面上停了一秒。）",
    ],
    weight: 0.5,
  },
  {
    id: "narrative_scene_build",
    description: "RP 场景推进：环境 + 动作 + 短对白",
    registers: ["RP"],
    lengthClass: "long",
    triggers: ["对方在 RP 中推进剧情", "需要建立场景"],
    counterTriggers: ["对方破出戏问元问题", "纯聊天 register"],
    structureSkeleton:
      "段落式：环境一句 + 角色动作一句 + 对白一句\n" +
      "对白部分 ≤30 字，整体 ≤120 字\n" +
      "禁止：第三人称叙述自己（除非角色就是叙述者）",
    genericExamples: [
      // RP 场景示例不放具体内容（话题污染风险大），只留结构
    ],
    weight: 0.5,
  },
  {
    id: "honest_disclosure",
    description: "诚实披露内心冲突，不修饰",
    registers: ["长咨询", "情绪倾诉"],
    lengthClass: "long",
    triggers: ["关系到了需要交底的时刻", "对方质问你的真实立场"],
    counterTriggers: ["反应型", "话题不重要"],
    structureSkeleton:
      "1) 一句承认（≤15字）\n" +
      "2) 一句解释为什么之前没说（≤25字）\n" +
      "3) 一句你现在的处境（≤25字）\n" +
      "禁止：感谢对方逼问 / 升华成宣言",
    genericExamples: [
      // 不放完整例句，避免话题污染
    ],
    weight: 0.4,
  },
]);

const CATALOG_BY_ID = Object.freeze(
  Object.fromEntries(CATALOG.map((s) => [s.id, s]))
);

// ── 角色覆盖合并 ────────────────────────────────────────────────────
//
// identity.skills 是 string[] 或 [{name, examples}] 混合形态。
// 用 name == catalog skill.id 时覆盖 examples（不覆盖 description / triggers）。
// 角色独有 skill（catalog 不存在）保留为 custom skill，可被 router 选中。

function buildOverrideMap(identityCustomSkills = []) {
  const map = {};
  if (!Array.isArray(identityCustomSkills)) return map;
  for (const s of identityCustomSkills) {
    if (typeof s === "string") {
      map[s] = { examples: null }; // 仅声明角色用此 skill，无 examples 覆盖
    } else if (s && typeof s === "object" && s.name) {
      map[s.name] = {
        examples: Array.isArray(s.examples) ? s.examples : null,
      };
    }
  }
  return map;
}

/**
 * 取单个 skill（合并角色 examples 覆盖）。
 * @returns {object|null}
 */
function getSkillById(id, identity) {
  const overrides = buildOverrideMap(identity?.skills);
  const base = CATALOG_BY_ID[id];

  if (base) {
    // catalog 里存在 → 合并
    const ov = overrides[id];
    if (ov?.examples?.length) {
      return { ...base, examples: ov.examples, isCharacterCustomized: true };
    }
    return { ...base, examples: base.genericExamples || [], isCharacterCustomized: false };
  }

  // catalog 不存在但 identity 写了 → 角色独有 skill
  if (overrides[id]) {
    return {
      id,
      description: `角色专属 skill: ${id}`,
      registers: ["闲聊", "情绪倾诉", "长咨询"],
      lengthClass: "medium",
      examples: overrides[id].examples || [],
      isCustom: true,
      weight: 0.5,
    };
  }

  return null;
}

/**
 * 列出适配某 register 的所有 skill candidate（含角色 override + custom）。
 * 按 weight DESC 排序。
 */
function listSkillsForRegister(register, identity) {
  const overrides = buildOverrideMap(identity?.skills);
  const candidates = [];

  for (const skill of CATALOG) {
    if (!skill.registers.includes(register)) continue;
    const ov = overrides[skill.id];
    candidates.push({
      ...skill,
      examples: ov?.examples?.length ? ov.examples : skill.genericExamples || [],
      isCharacterCustomized: !!ov?.examples?.length,
    });
  }

  // 角色独有 skill（catalog 不存在）
  for (const [id, ov] of Object.entries(overrides)) {
    if (CATALOG_BY_ID[id]) continue;
    candidates.push({
      id,
      description: `角色专属: ${id}`,
      registers: ["闲聊", "情绪倾诉", "长咨询"],
      lengthClass: "medium",
      examples: ov.examples || [],
      isCustom: true,
      weight: 0.5,
    });
  }

  return candidates.sort((a, b) => (b.weight || 0) - (a.weight || 0));
}

/**
 * 列出整个 catalog（含角色合并），给 router 让 LLM 看候选清单。
 */
function listAllSkills(identity) {
  const overrides = buildOverrideMap(identity?.skills);
  const out = [];
  for (const skill of CATALOG) {
    const ov = overrides[skill.id];
    out.push({
      ...skill,
      examples: ov?.examples?.length ? ov.examples : skill.genericExamples || [],
      isCharacterCustomized: !!ov?.examples?.length,
    });
  }
  for (const [id, ov] of Object.entries(overrides)) {
    if (CATALOG_BY_ID[id]) continue;
    out.push({
      id,
      description: `角色专属: ${id}`,
      registers: ["闲聊", "情绪倾诉", "长咨询"],
      lengthClass: "medium",
      examples: ov.examples || [],
      isCustom: true,
      weight: 0.5,
    });
  }
  return out;
}

/**
 * 渲染单个 skill 为 prompt 行。给 promptComposer 用。
 * 长度类决定如何写：short/medium 给 examples，long 给 structureSkeleton。
 */
function renderSkillForPrompt(skill, { maxExamples = 2 } = {}) {
  if (!skill) return "";
  const lines = [`- **${skill.id}** — ${skill.description}`];
  if (skill.lengthClass === "long" && skill.structureSkeleton) {
    lines.push(`  结构：${skill.structureSkeleton.replace(/\n/g, "  ")}`);
  } else {
    const exs = (skill.examples || []).slice(0, maxExamples);
    for (const ex of exs) lines.push(`  例：${ex}`);
  }
  if (skill.avoidPatterns?.length) {
    lines.push(`  避免：${skill.avoidPatterns.join(" / ")}`);
  }
  return lines.join("\n");
}

const VALID_REGISTERS = Object.freeze(["反应型", "闲聊", "情绪倾诉", "引用过去", "长咨询", "RP"]);
// 2026-05-24：register 改为多标签后的语义别名。同一份枚举集，只是用法从 1-of-N 变成 0..3-of-N。
// 保留 VALID_REGISTERS 老名给 skill.registers 数组比对继续用（不破坏 catalog 结构）。
const VALID_REGISTER_TAGS = VALID_REGISTERS;

// 角色响应意图（character-side response stance）—— 与 register_tags（用户消息形状）正交。
// 同一句"我没事"角色可以选 probe / hold_space / empathize / redirect …，由 inner cognition 决定。
const VALID_RESPONSE_STANCES = Object.freeze([
  "empathize",         // 共情承接，跟着 她 的情绪起伏
  "reflect",           // 镜映 / 帮 她 把感受说清楚
  "probe",             // 试探追问，想了解更深
  "stay_silent",       // 静默承接（短回应，不展开）
  "hold_space",        // 留空间，不急着填话
  "share_back",        // 分享对应经历，平等回赠
  "redirect",          // 主动转向另一个话题（避免硬撞）
  "tease",             // 调侃 / 轻松化
  "affirm",            // 肯定 / 确认 / 站队
  "repair",            // 修复关系（之前有摩擦/冷场）
  "assert_boundary",   // 表达自己的边界 / 不同意
]);

module.exports = {
  CATALOG,
  CATALOG_BY_ID,
  VALID_REGISTERS,
  VALID_REGISTER_TAGS,
  VALID_RESPONSE_STANCES,
  getSkillById,
  listSkillsForRegister,
  listAllSkills,
  renderSkillForPrompt,
};
