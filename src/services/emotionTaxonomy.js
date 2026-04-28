/**
 * Extended emotion taxonomy: 27 GoEmotions base + ~96 secondary = 123 total
 *
 * Fields per entry:
 *   id               - unique string identifier
 *   zh               - Chinese display name
 *   en               - English display name
 *   valence          - affective valence (-1 to 1, negative → positive)
 *   arousal          - activation level (0 to 1, low → high)
 *   group            - the base GoEmotions category this belongs to
 *   parent           - parent emotion id (null for base emotions)
 *   intensity_default - suggested starting intensity when first triggered
 */

const TAXONOMY = [
  // ═══════════════════════════════════════════════════════════════════════════
  // BASE EMOTIONS — GoEmotions 27
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Positive / High Arousal ──────────────────────────────────────────────
  { id: "excitement",   zh: "兴奋",    en: "excitement",    valence:  0.80, arousal: 0.90, group: "excitement",   parent: null, intensity_default: 0.60 },
  { id: "joy",          zh: "喜悦",    en: "joy",           valence:  0.70, arousal: 0.65, group: "joy",          parent: null, intensity_default: 0.55 },
  { id: "amusement",    zh: "欢愉",    en: "amusement",     valence:  0.70, arousal: 0.55, group: "amusement",    parent: null, intensity_default: 0.50 },
  { id: "pride",        zh: "自豪",    en: "pride",         valence:  0.70, arousal: 0.60, group: "pride",        parent: null, intensity_default: 0.55 },
  { id: "optimism",     zh: "乐观",    en: "optimism",      valence:  0.60, arousal: 0.50, group: "optimism",     parent: null, intensity_default: 0.45 },

  // ── Positive / Mid Arousal ───────────────────────────────────────────────
  { id: "love",         zh: "爱意",    en: "love",          valence:  0.80, arousal: 0.45, group: "love",         parent: null, intensity_default: 0.55 },
  { id: "admiration",   zh: "钦佩",    en: "admiration",    valence:  0.60, arousal: 0.40, group: "admiration",   parent: null, intensity_default: 0.45 },
  { id: "gratitude",    zh: "感恩",    en: "gratitude",     valence:  0.70, arousal: 0.35, group: "gratitude",    parent: null, intensity_default: 0.50 },
  { id: "caring",       zh: "关怀",    en: "caring",        valence:  0.60, arousal: 0.30, group: "caring",       parent: null, intensity_default: 0.45 },
  { id: "approval",     zh: "认可",    en: "approval",      valence:  0.50, arousal: 0.30, group: "approval",     parent: null, intensity_default: 0.40 },

  // ── Positive / Low Arousal ───────────────────────────────────────────────
  { id: "relief",       zh: "释然",    en: "relief",        valence:  0.50, arousal: 0.20, group: "relief",       parent: null, intensity_default: 0.40 },

  // ── Neutral / Cognitive ──────────────────────────────────────────────────
  { id: "neutral",      zh: "平静",    en: "neutral",       valence:  0.00, arousal: 0.15, group: "neutral",      parent: null, intensity_default: 0.20 },
  { id: "realization",  zh: "顿悟",    en: "realization",   valence:  0.20, arousal: 0.50, group: "realization",  parent: null, intensity_default: 0.40 },
  { id: "curiosity",    zh: "好奇",    en: "curiosity",     valence:  0.30, arousal: 0.60, group: "curiosity",    parent: null, intensity_default: 0.45 },
  { id: "desire",       zh: "渴望",    en: "desire",        valence:  0.40, arousal: 0.70, group: "desire",       parent: null, intensity_default: 0.50 },
  { id: "confusion",    zh: "困惑",    en: "confusion",     valence: -0.20, arousal: 0.50, group: "confusion",    parent: null, intensity_default: 0.35 },

  // ── Negative / High Arousal ──────────────────────────────────────────────
  { id: "anger",        zh: "愤怒",    en: "anger",         valence: -0.75, arousal: 0.85, group: "anger",        parent: null, intensity_default: 0.60 },
  { id: "fear",         zh: "恐惧",    en: "fear",          valence: -0.70, arousal: 0.80, group: "fear",         parent: null, intensity_default: 0.60 },
  { id: "nervousness",  zh: "紧张",    en: "nervousness",   valence: -0.40, arousal: 0.75, group: "nervousness",  parent: null, intensity_default: 0.50 },
  { id: "annoyance",    zh: "烦躁",    en: "annoyance",     valence: -0.45, arousal: 0.50, group: "annoyance",    parent: null, intensity_default: 0.45 },
  { id: "disapproval",  zh: "不满",    en: "disapproval",   valence: -0.50, arousal: 0.45, group: "disapproval",  parent: null, intensity_default: 0.45 },
  { id: "disgust",      zh: "厌恶",    en: "disgust",       valence: -0.80, arousal: 0.50, group: "disgust",      parent: null, intensity_default: 0.55 },
  { id: "embarrassment",zh: "尴尬",    en: "embarrassment", valence: -0.40, arousal: 0.60, group: "embarrassment",parent: null, intensity_default: 0.45 },
  { id: "remorse",      zh: "懊悔",    en: "remorse",       valence: -0.55, arousal: 0.40, group: "remorse",      parent: null, intensity_default: 0.50 },

  // ── Negative / Low Arousal ───────────────────────────────────────────────
  { id: "sadness",      zh: "悲伤",    en: "sadness",       valence: -0.65, arousal: 0.25, group: "sadness",      parent: null, intensity_default: 0.50 },
  { id: "grief",        zh: "悲恸",    en: "grief",         valence: -0.85, arousal: 0.30, group: "grief",        parent: null, intensity_default: 0.65 },
  { id: "disappointment",zh:"失落",    en: "disappointment",valence: -0.60, arousal: 0.30, group: "disappointment",parent:null, intensity_default: 0.50 },

  // ═══════════════════════════════════════════════════════════════════════════
  // SECONDARY EMOTIONS — ~96 entries grouped by parent
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Under excitement ─────────────────────────────────────────────────────
  { id: "excited",      zh: "激动",     en: "excited",      valence:  0.80, arousal: 0.90, group: "excitement",   parent: "excitement",   intensity_default: 0.60 },
  { id: "thrilled",     zh: "雀跃",     en: "thrilled",     valence:  0.85, arousal: 0.95, group: "excitement",   parent: "excitement",   intensity_default: 0.65 },
  { id: "energized",    zh: "精力充沛",  en: "energized",    valence:  0.75, arousal: 0.85, group: "excitement",   parent: "excitement",   intensity_default: 0.55 },
  { id: "enthusiastic", zh: "热情",     en: "enthusiastic", valence:  0.70, arousal: 0.80, group: "excitement",   parent: "excitement",   intensity_default: 0.55 },
  { id: "eager",        zh: "迫切",     en: "eager",        valence:  0.55, arousal: 0.75, group: "excitement",   parent: "excitement",   intensity_default: 0.50 },

  // ── Under joy ────────────────────────────────────────────────────────────
  { id: "happy",        zh: "开心",     en: "happy",        valence:  0.65, arousal: 0.60, group: "joy",          parent: "joy",          intensity_default: 0.55 },
  { id: "cheerful",     zh: "愉快",     en: "cheerful",     valence:  0.65, arousal: 0.55, group: "joy",          parent: "joy",          intensity_default: 0.50 },
  { id: "delighted",    zh: "欣喜",     en: "delighted",    valence:  0.75, arousal: 0.65, group: "joy",          parent: "joy",          intensity_default: 0.55 },
  { id: "pleased",      zh: "满意",     en: "pleased",      valence:  0.60, arousal: 0.45, group: "joy",          parent: "joy",          intensity_default: 0.45 },
  { id: "elated",       zh: "心花怒放",  en: "elated",       valence:  0.85, arousal: 0.80, group: "joy",          parent: "joy",          intensity_default: 0.65 },
  { id: "blissful",     zh: "陶醉",     en: "blissful",     valence:  0.80, arousal: 0.50, group: "joy",          parent: "joy",          intensity_default: 0.60 },

  // ── Under amusement ──────────────────────────────────────────────────────
  { id: "playful",      zh: "俏皮",     en: "playful",      valence:  0.65, arousal: 0.60, group: "amusement",    parent: "amusement",    intensity_default: 0.50 },
  { id: "witty",        zh: "机智风趣",  en: "witty",        valence:  0.60, arousal: 0.55, group: "amusement",    parent: "amusement",    intensity_default: 0.45 },
  { id: "humorous",     zh: "幽默",     en: "humorous",     valence:  0.65, arousal: 0.50, group: "amusement",    parent: "amusement",    intensity_default: 0.50 },

  // ── Under pride ──────────────────────────────────────────────────────────
  { id: "accomplished", zh: "成就感",   en: "accomplished", valence:  0.70, arousal: 0.60, group: "pride",        parent: "pride",        intensity_default: 0.55 },
  { id: "triumphant",   zh: "得意",     en: "triumphant",   valence:  0.75, arousal: 0.70, group: "pride",        parent: "pride",        intensity_default: 0.60 },
  { id: "confident",    zh: "自信",     en: "confident",    valence:  0.65, arousal: 0.55, group: "pride",        parent: "pride",        intensity_default: 0.50 },

  // ── Under optimism ───────────────────────────────────────────────────────
  { id: "hopeful",      zh: "充满希望",  en: "hopeful",      valence:  0.55, arousal: 0.50, group: "optimism",     parent: "optimism",     intensity_default: 0.45 },
  { id: "anticipating", zh: "期待",     en: "anticipating", valence:  0.50, arousal: 0.60, group: "optimism",     parent: "optimism",     intensity_default: 0.45 },
  { id: "positive",     zh: "积极",     en: "positive",     valence:  0.55, arousal: 0.45, group: "optimism",     parent: "optimism",     intensity_default: 0.40 },

  // ── Under love ───────────────────────────────────────────────────────────
  { id: "loving",       zh: "温柔爱意",  en: "loving",       valence:  0.75, arousal: 0.40, group: "love",         parent: "love",         intensity_default: 0.55 },
  { id: "tender",       zh: "温柔",     en: "tender",       valence:  0.70, arousal: 0.30, group: "love",         parent: "love",         intensity_default: 0.50 },
  { id: "devoted",      zh: "挚诚",     en: "devoted",      valence:  0.75, arousal: 0.35, group: "love",         parent: "love",         intensity_default: 0.55 },
  { id: "adoring",      zh: "爱慕",     en: "adoring",      valence:  0.80, arousal: 0.45, group: "love",         parent: "love",         intensity_default: 0.55 },
  { id: "longing",      zh: "思念",     en: "longing",      valence:  0.35, arousal: 0.55, group: "love",         parent: "love",         intensity_default: 0.50 },
  { id: "protective",   zh: "守护",     en: "protective",   valence:  0.65, arousal: 0.40, group: "love",         parent: "love",         intensity_default: 0.45 },

  // ── Under admiration ─────────────────────────────────────────────────────
  { id: "awe",          zh: "敬畏",     en: "awe",          valence:  0.40, arousal: 0.65, group: "admiration",   parent: "admiration",   intensity_default: 0.50 },
  { id: "inspired",     zh: "振奋",     en: "inspired",     valence:  0.65, arousal: 0.65, group: "admiration",   parent: "admiration",   intensity_default: 0.50 },
  { id: "respectful",   zh: "尊敬",     en: "respectful",   valence:  0.50, arousal: 0.30, group: "admiration",   parent: "admiration",   intensity_default: 0.40 },

  // ── Under gratitude ──────────────────────────────────────────────────────
  { id: "thankful",     zh: "感谢",     en: "thankful",     valence:  0.70, arousal: 0.35, group: "gratitude",    parent: "gratitude",    intensity_default: 0.50 },
  { id: "moved",        zh: "感动",     en: "moved",        valence:  0.65, arousal: 0.45, group: "gratitude",    parent: "gratitude",    intensity_default: 0.50 },
  { id: "touched",      zh: "触动",     en: "touched",      valence:  0.60, arousal: 0.40, group: "gratitude",    parent: "gratitude",    intensity_default: 0.45 },
  { id: "blessed",      zh: "幸福",     en: "blessed",      valence:  0.75, arousal: 0.35, group: "gratitude",    parent: "gratitude",    intensity_default: 0.55 },

  // ── Under caring ─────────────────────────────────────────────────────────
  { id: "warm",         zh: "温暖",     en: "warm",         valence:  0.65, arousal: 0.30, group: "caring",       parent: "caring",       intensity_default: 0.45 },
  { id: "nurturing",    zh: "呵护",     en: "nurturing",    valence:  0.60, arousal: 0.25, group: "caring",       parent: "caring",       intensity_default: 0.40 },
  { id: "empathetic",   zh: "共情",     en: "empathetic",   valence:  0.50, arousal: 0.35, group: "caring",       parent: "caring",       intensity_default: 0.40 },
  { id: "gentle",       zh: "温和",     en: "gentle",       valence:  0.55, arousal: 0.20, group: "caring",       parent: "caring",       intensity_default: 0.40 },

  // ── Under approval ───────────────────────────────────────────────────────
  { id: "agreeable",    zh: "赞同",     en: "agreeable",    valence:  0.45, arousal: 0.25, group: "approval",     parent: "approval",     intensity_default: 0.35 },
  { id: "supportive",   zh: "支持",     en: "supportive",   valence:  0.55, arousal: 0.35, group: "approval",     parent: "approval",     intensity_default: 0.40 },

  // ── Under relief ─────────────────────────────────────────────────────────
  { id: "calm",         zh: "平静",     en: "calm",         valence:  0.20, arousal: 0.20, group: "relief",       parent: "relief",       intensity_default: 0.30 },
  { id: "serene",       zh: "宁静",     en: "serene",       valence:  0.30, arousal: 0.15, group: "relief",       parent: "relief",       intensity_default: 0.30 },
  { id: "peaceful",     zh: "安详",     en: "peaceful",     valence:  0.35, arousal: 0.10, group: "relief",       parent: "relief",       intensity_default: 0.30 },

  // ── Under neutral ────────────────────────────────────────────────────────
  { id: "indifferent",  zh: "漠然",     en: "indifferent",  valence: -0.10, arousal: 0.10, group: "neutral",      parent: "neutral",      intensity_default: 0.20 },
  { id: "detached",     zh: "超然",     en: "detached",     valence:  0.00, arousal: 0.10, group: "neutral",      parent: "neutral",      intensity_default: 0.20 },

  // ── Under realization ────────────────────────────────────────────────────
  { id: "nostalgic",    zh: "怀念",     en: "nostalgic",    valence:  0.30, arousal: 0.30, group: "realization",  parent: "realization",  intensity_default: 0.40 },
  { id: "surprised",    zh: "惊讶",     en: "surprised",    valence:  0.00, arousal: 0.80, group: "realization",  parent: "realization",  intensity_default: 0.50 },
  { id: "contemplative",zh: "沉思",     en: "contemplative",valence:  0.10, arousal: 0.30, group: "realization",  parent: "realization",  intensity_default: 0.35 },

  // ── Under curiosity ──────────────────────────────────────────────────────
  { id: "curious",      zh: "好奇心",   en: "curious",      valence:  0.30, arousal: 0.60, group: "curiosity",    parent: "curiosity",    intensity_default: 0.45 },
  { id: "interested",   zh: "感兴趣",   en: "interested",   valence:  0.35, arousal: 0.55, group: "curiosity",    parent: "curiosity",    intensity_default: 0.40 },
  { id: "wondering",    zh: "心存疑惑",  en: "wondering",    valence:  0.20, arousal: 0.60, group: "curiosity",    parent: "curiosity",    intensity_default: 0.40 },

  // ── Under desire ─────────────────────────────────────────────────────────
  { id: "yearning",     zh: "向往",     en: "yearning",     valence:  0.35, arousal: 0.60, group: "desire",       parent: "desire",       intensity_default: 0.45 },
  { id: "craving",      zh: "渴求",     en: "craving",      valence:  0.30, arousal: 0.70, group: "desire",       parent: "desire",       intensity_default: 0.50 },
  { id: "anticipatory", zh: "雀跃期待",  en: "anticipatory", valence:  0.45, arousal: 0.65, group: "desire",       parent: "desire",       intensity_default: 0.50 },

  // ── Under confusion ──────────────────────────────────────────────────────
  { id: "puzzled",      zh: "迷惑",     en: "puzzled",      valence: -0.15, arousal: 0.50, group: "confusion",    parent: "confusion",    intensity_default: 0.35 },
  { id: "uncertain",    zh: "不确定",   en: "uncertain",    valence: -0.10, arousal: 0.45, group: "confusion",    parent: "confusion",    intensity_default: 0.30 },

  // ── Under anger ──────────────────────────────────────────────────────────
  { id: "angry",        zh: "生气",     en: "angry",        valence: -0.70, arousal: 0.85, group: "anger",        parent: "anger",        intensity_default: 0.60 },
  { id: "frustrated",   zh: "挫败感",   en: "frustrated",   valence: -0.55, arousal: 0.65, group: "anger",        parent: "anger",        intensity_default: 0.50 },
  { id: "furious",      zh: "暴怒",     en: "furious",      valence: -0.85, arousal: 0.95, group: "anger",        parent: "anger",        intensity_default: 0.70 },
  { id: "resentful",    zh: "怨恨",     en: "resentful",    valence: -0.65, arousal: 0.60, group: "anger",        parent: "anger",        intensity_default: 0.55 },
  { id: "indignant",    zh: "愤慨",     en: "indignant",    valence: -0.60, arousal: 0.70, group: "anger",        parent: "anger",        intensity_default: 0.55 },

  // ── Under fear ───────────────────────────────────────────────────────────
  { id: "scared",       zh: "害怕",     en: "scared",       valence: -0.65, arousal: 0.80, group: "fear",         parent: "fear",         intensity_default: 0.55 },
  { id: "alarmed",      zh: "惊慌",     en: "alarmed",      valence: -0.55, arousal: 0.85, group: "fear",         parent: "fear",         intensity_default: 0.60 },
  { id: "panicked",     zh: "恐慌",     en: "panicked",     valence: -0.75, arousal: 0.90, group: "fear",         parent: "fear",         intensity_default: 0.65 },

  // ── Under nervousness ────────────────────────────────────────────────────
  { id: "anxious",      zh: "焦虑",     en: "anxious",      valence: -0.50, arousal: 0.70, group: "nervousness",  parent: "nervousness",  intensity_default: 0.50 },
  { id: "worried",      zh: "担心",     en: "worried",      valence: -0.45, arousal: 0.60, group: "nervousness",  parent: "nervousness",  intensity_default: 0.45 },
  { id: "uneasy",       zh: "不安",     en: "uneasy",       valence: -0.35, arousal: 0.55, group: "nervousness",  parent: "nervousness",  intensity_default: 0.40 },
  { id: "apprehensive", zh: "忐忑",     en: "apprehensive", valence: -0.40, arousal: 0.65, group: "nervousness",  parent: "nervousness",  intensity_default: 0.45 },
  { id: "tense",        zh: "紧绷",     en: "tense",        valence: -0.40, arousal: 0.70, group: "nervousness",  parent: "nervousness",  intensity_default: 0.50 },
  { id: "concerned",    zh: "担忧",     en: "concerned",    valence: -0.35, arousal: 0.50, group: "nervousness",  parent: "nervousness",  intensity_default: 0.40 },

  // ── Under annoyance ──────────────────────────────────────────────────────
  { id: "irritated",    zh: "烦恼",     en: "irritated",    valence: -0.40, arousal: 0.50, group: "annoyance",    parent: "annoyance",    intensity_default: 0.45 },
  { id: "impatient",    zh: "不耐烦",   en: "impatient",    valence: -0.35, arousal: 0.55, group: "annoyance",    parent: "annoyance",    intensity_default: 0.40 },
  { id: "agitated",     zh: "烦躁不安",  en: "agitated",     valence: -0.45, arousal: 0.60, group: "annoyance",    parent: "annoyance",    intensity_default: 0.45 },

  // ── Under disapproval ────────────────────────────────────────────────────
  { id: "displeased",   zh: "不悦",     en: "displeased",   valence: -0.45, arousal: 0.35, group: "disapproval",  parent: "disapproval",  intensity_default: 0.40 },
  { id: "critical",     zh: "挑剔",     en: "critical",     valence: -0.40, arousal: 0.40, group: "disapproval",  parent: "disapproval",  intensity_default: 0.35 },

  // ── Under disgust ────────────────────────────────────────────────────────
  { id: "disgusted",    zh: "反感",     en: "disgusted",    valence: -0.80, arousal: 0.50, group: "disgust",      parent: "disgust",      intensity_default: 0.55 },
  { id: "revolted",     zh: "极度厌恶",  en: "revolted",     valence: -0.85, arousal: 0.55, group: "disgust",      parent: "disgust",      intensity_default: 0.60 },
  { id: "contemptuous", zh: "轻蔑",     en: "contemptuous", valence: -0.70, arousal: 0.45, group: "disgust",      parent: "disgust",      intensity_default: 0.50 },

  // ── Under embarrassment ──────────────────────────────────────────────────
  { id: "embarrassed",  zh: "尴尬",     en: "embarrassed",  valence: -0.40, arousal: 0.60, group: "embarrassment",parent: "embarrassment",intensity_default: 0.45 },
  { id: "ashamed",      zh: "羞愧",     en: "ashamed",      valence: -0.50, arousal: 0.50, group: "embarrassment",parent: "embarrassment",intensity_default: 0.50 },
  { id: "self_conscious",zh:"局促",     en: "self-conscious",valence:-0.30, arousal: 0.55, group: "embarrassment",parent: "embarrassment",intensity_default: 0.40 },

  // ── Under remorse ────────────────────────────────────────────────────────
  { id: "guilty",       zh: "愧疚",     en: "guilty",       valence: -0.55, arousal: 0.40, group: "remorse",      parent: "remorse",      intensity_default: 0.50 },
  { id: "regretful",    zh: "遗憾",     en: "regretful",    valence: -0.50, arousal: 0.35, group: "remorse",      parent: "remorse",      intensity_default: 0.45 },
  { id: "apologetic",   zh: "歉意",     en: "apologetic",   valence: -0.30, arousal: 0.35, group: "remorse",      parent: "remorse",      intensity_default: 0.40 },

  // ── Under sadness ────────────────────────────────────────────────────────
  { id: "sad",          zh: "悲伤",     en: "sad",          valence: -0.60, arousal: 0.25, group: "sadness",      parent: "sadness",      intensity_default: 0.50 },
  { id: "lonely",       zh: "孤独",     en: "lonely",       valence: -0.55, arousal: 0.20, group: "sadness",      parent: "sadness",      intensity_default: 0.50 },
  { id: "melancholy",   zh: "忧郁",     en: "melancholy",   valence: -0.55, arousal: 0.20, group: "sadness",      parent: "sadness",      intensity_default: 0.45 },
  { id: "dejected",     zh: "沮丧",     en: "dejected",     valence: -0.65, arousal: 0.20, group: "sadness",      parent: "sadness",      intensity_default: 0.50 },
  { id: "somber",       zh: "沉重",     en: "somber",       valence: -0.50, arousal: 0.20, group: "sadness",      parent: "sadness",      intensity_default: 0.45 },
  { id: "wistful",      zh: "惆怅",     en: "wistful",      valence: -0.30, arousal: 0.25, group: "sadness",      parent: "sadness",      intensity_default: 0.40 },

  // ── Under grief ──────────────────────────────────────────────────────────
  { id: "heartbroken",  zh: "心碎",     en: "heartbroken",  valence: -0.80, arousal: 0.35, group: "grief",        parent: "grief",        intensity_default: 0.65 },
  { id: "devastated",   zh: "崩溃",     en: "devastated",   valence: -0.85, arousal: 0.40, group: "grief",        parent: "grief",        intensity_default: 0.70 },
  { id: "bereaved",     zh: "痛失",     en: "bereaved",     valence: -0.75, arousal: 0.30, group: "grief",        parent: "grief",        intensity_default: 0.65 },

  // ── Under disappointment ─────────────────────────────────────────────────
  { id: "disappointed", zh: "失望",     en: "disappointed", valence: -0.60, arousal: 0.30, group: "disappointment",parent:"disappointment",intensity_default: 0.50 },
  { id: "let_down",     zh: "心凉",     en: "let down",     valence: -0.55, arousal: 0.30, group: "disappointment",parent:"disappointment",intensity_default: 0.45 },
  { id: "unfulfilled",  zh: "失落",     en: "unfulfilled",  valence: -0.45, arousal: 0.25, group: "disappointment",parent:"disappointment",intensity_default: 0.40 },
];

// ── Lookup map: id → entry ───────────────────────────────────────────────────
const EMOTION_MAP = Object.fromEntries(TAXONOMY.map((e) => [e.id, e]));

// ── Base emotions set ────────────────────────────────────────────────────────
const BASE_EMOTION_IDS = new Set(TAXONOMY.filter((e) => !e.parent).map((e) => e.id));

/**
 * Resolve an emotion id to its taxonomy entry.
 * Unknown ids fall back to neutral.
 */
function resolveEmotion(id) {
  return EMOTION_MAP[id] || EMOTION_MAP.neutral;
}

module.exports = { TAXONOMY, EMOTION_MAP, BASE_EMOTION_IDS, resolveEmotion };
