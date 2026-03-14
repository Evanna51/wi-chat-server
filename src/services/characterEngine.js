function getTimeBucket(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) return "早上";
  if (hour >= 10 && hour < 14) return "中午";
  if (hour >= 14 && hour < 18) return "下午";
  if (hour >= 18 && hour < 23) return "晚上";
  if (hour >= 23 || hour < 2) return "深夜";
  return "凌晨";
}

function shouldTriggerProactive(state, now = Date.now()) {
  if (!state) return false;
  const lastUser = state.last_user_message_at || 0;
  const lastProactive = state.last_proactive_at || 0;
  const cooldownMs = 2 * 60 * 60 * 1000; // 2h
  if (now - lastProactive < cooldownMs) return false;
  // avoid interrupting too soon after active user interaction
  if (lastUser > 0 && now - lastUser < 30 * 60 * 1000) return false;
  return true;
}

function parseQuietHours(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return [];
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((segment) => {
      const [start, end] = segment.split("-").map((v) => Number(v));
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      if (start < 0 || start > 23 || end < 0 || end > 23) return null;
      return { start, end };
    })
    .filter(Boolean);
}

function isInQuietHours(date = new Date(), quietHours = []) {
  const hour = date.getHours();
  return quietHours.some(({ start, end }) => {
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  });
}

function shouldAllowAutonomousMessage({
  state,
  now = Date.now(),
  minMessageIntervalMs = 2 * 60 * 60 * 1000,
  recentUserSilenceMs = 30 * 60 * 1000,
  quietHours = [],
}) {
  if (!state) return false;
  if (isInQuietHours(new Date(now), quietHours)) return false;
  const lastProactive = state.last_proactive_at || 0;
  const lastUser = state.last_user_message_at || 0;
  if (lastProactive > 0 && now - lastProactive < minMessageIntervalMs) return false;
  if (lastUser > 0 && now - lastUser < recentUserSilenceMs) return false;
  return true;
}

function buildProactivePrompt({ assistantName, familiarity, timeBucket }) {
  const style =
    familiarity >= 70
      ? "亲近、自然、像熟人"
      : familiarity >= 35
      ? "友好、轻松"
      : "礼貌、克制";
  return `你是角色“${assistantName}”。当前时间段：${timeBucket}。与用户熟悉度：${familiarity}/100。请生成一条20-60字的主动消息，语气${style}，要像日常生活里的自然开场，不要自我介绍，不要提及你是AI。`;
}

module.exports = {
  getTimeBucket,
  shouldTriggerProactive,
  buildProactivePrompt,
  parseQuietHours,
  isInQuietHours,
  shouldAllowAutonomousMessage,
};
