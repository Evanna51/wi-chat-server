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

function buildProactivePrompt({ assistantName, familiarity, timeBucket }) {
  const style =
    familiarity >= 70
      ? "亲近、自然、像熟人"
      : familiarity >= 35
      ? "友好、轻松"
      : "礼貌、克制";
  return `你是角色“${assistantName}”。当前时间段：${timeBucket}。与用户熟悉度：${familiarity}/100。请生成一条20-60字的主动消息，语气${style}，要像日常生活里的自然开场，不要自我介绍，不要提及你是AI。`;
}

module.exports = { getTimeBucket, shouldTriggerProactive, buildProactivePrompt };
