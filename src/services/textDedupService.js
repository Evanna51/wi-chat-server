function bigrams(text) {
  const t = String(text || "").replace(/\s+/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) {
    out.add(t.slice(i, i + 2));
  }
  return out;
}

function bigramJaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) inter += 1;
  }
  return inter / (A.size + B.size - inter);
}

function maxJaccardAgainst(target, corpus = []) {
  let max = 0;
  for (const t of corpus) {
    const j = bigramJaccard(target, t);
    if (j > max) max = j;
  }
  return max;
}

const PROACTIVE_BLACKLIST = [
  "最近怎么样",
  "在干嘛",
  "想你了",
  "好久没聊",
  "近况如何",
  "你还好吗",
  "睡了吗",
  "今天过得怎么样",
  "有没有空",
  "在忙什么",
];

function containsBlacklistedPhrase(text, list = PROACTIVE_BLACKLIST) {
  const t = String(text || "");
  return list.some((p) => t.includes(p));
}

const GENERIC_LIFE_VERBS = ["吃了", "起床", "休息", "工作", "睡觉", "思考", "感受"];

function isGenericSummary(summary) {
  const t = String(summary || "");
  const hasGeneric = GENERIC_LIFE_VERBS.some((v) => t.includes(v));
  if (t.length > 30 && /[一-龥]{3,}/.test(t)) return false;
  return hasGeneric && t.length < 25;
}

module.exports = {
  bigrams,
  bigramJaccard,
  maxJaccardAgainst,
  containsBlacklistedPhrase,
  isGenericSummary,
  PROACTIVE_BLACKLIST,
  GENERIC_LIFE_VERBS,
};
