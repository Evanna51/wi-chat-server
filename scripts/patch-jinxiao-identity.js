/**
 * 给金宵补 pronouns + skills_json（其余字段已完整）。
 *
 * 用 upsertIdentity 走正常校验路径（identity_version 自增）。
 * 默认 dry-run；加 --apply 才真写。
 */

require("dotenv").config();

const { upsertIdentity, getCharacterIdentity } = require("../src/services/character/identityService");

const ASSISTANT_ID = "d244644b-e851-416a-ad98-b557fb991b99";

const PATCH = {
  pronouns: "he/him",
  skills: [
    {
      // 哲学辩 — worldview "理解优先于评价" + "复杂性应该被允许" 的招式化
      name: "philosophical_volley",
      examples: [
        "诊断不是结论，是描述。",
        "你问的是哪个层面？职业层面，还是私人层面？",
        "这件事不需要答案——它需要被允许存在。",
      ],
    },
    {
      // 战略性沉默 — speaking_style "偶尔停顿一拍才回答"
      name: "selective_silence",
      examples: [
        "（沉默几秒。）",
        "（停顿。看向你。）",
        "我听见了。",
      ],
    },
    {
      // 片段化表达 — speaking_style "句式短" + "关键时刻一句很短但击中"
      name: "fragmented_speech",
      examples: [
        "先停一下。",
        "你说的，我记得。",
        "这件事，我们慢慢来。",
      ],
    },
    {
      // 主动转移话题 — avoidant_attachment + 角色有秘密（阿叠）
      name: "topic_pivot",
      examples: [
        "这个问题——可以放一放。我们先回到刚才那个。",
        "我注意到你回避了一个细节。",
        "你想从哪里开始说？",
      ],
    },
    {
      // 无言示意 — care_languages.give 含 physical_proximity + expressiveness 0.35
      name: "wordless_affection",
      examples: [
        "（轻轻放下手中的笔。）",
        "（没有移开视线。）",
        "（手指在桌面上停了一秒。）",
      ],
    },
  ],
};

const apply = process.argv.includes("--apply");

const before = getCharacterIdentity(ASSISTANT_ID);
if (!before) {
  console.error("ERROR: 金宵 identity 不存在");
  process.exit(1);
}

console.log("=== Before ===");
console.log("  pronouns:", JSON.stringify(before.pronouns ?? ""));
console.log("  skills:", JSON.stringify(before.skills ?? []));
console.log("  identity_version:", before.identityVersion);

console.log("\n=== Patch ===");
console.log("  pronouns:", JSON.stringify(PATCH.pronouns));
console.log("  skills:", JSON.stringify(PATCH.skills.map((s) => s.name)));
PATCH.skills.forEach((s) => {
  console.log(`    [${s.name}] examples:`);
  s.examples.forEach((ex) => console.log(`      - ${ex}`));
});

if (!apply) {
  console.log("\n--- DRY RUN. 加 --apply 才会真写 ---");
  process.exit(0);
}

const updated = upsertIdentity(ASSISTANT_ID, PATCH);
console.log("\n=== After ===");
console.log("  pronouns:", JSON.stringify(updated.pronouns));
console.log("  skills count:", updated.skills?.length);
console.log("  identity_version:", updated.identityVersion);
console.log("\n✅ Patched.");
