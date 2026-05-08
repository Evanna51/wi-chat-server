-- Migration 028: Narrative Memory + Persistent Topic (Phase CC-2)
--
-- Phase CC-1 把"角色"做成了有 identity + 多维关系 + 情绪惯性的认知体。
-- 但记忆仍然是 atomic memory_items —— LLM 检索回来一堆 "user 喜欢钢琴 (created_at=...)"
-- 而没有"那段你失恋时"、"工作崩溃那几周"这种**故事化**的上下文。
--
-- 本次加两个第一公民概念：
--   narrative_episode  — 多条 memory_items 合成的"那段时间发生了什么"
--   persistent_topic    — 跨多个 episode 反复出现的长期话题（钢琴学习、家庭关系）
--
-- 为什么不直接复用 memory_items + memory_edges：
--   memory_items 是 atomic、向量化、按 turn 分类。episode 是高维抽象 + 时间窗 +
--   情感色调，强类型上不同。memory_edges 也是"memory↔memory"双端同型，
--   episode↔memory 是"概念↔实例"不同型，硬塞进去会模糊语义。

CREATE TABLE IF NOT EXISTS narrative_episode (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  -- 自然语言的标题，约 8-20 字。例 "你失恋那段时间" "钢琴学习初期"
  title TEXT NOT NULL,
  -- 1-3 段叙事性总结。检索时直接进 prompt。
  summary TEXT NOT NULL,
  -- 谁参与了这段叙事。JSON 字符串数组，例 ["user","assistant","用户的母亲"]
  participants_json TEXT NOT NULL DEFAULT '["user","assistant"]',
  -- emotional_tone: 'painful' | 'nostalgic' | 'healing' | 'exciting' | 'tender' | 'tense' | 'mundane'
  emotional_tone TEXT NOT NULL DEFAULT 'mundane',
  -- importance 0-1，决定检索时是否带回。不衰减（有些故事就是核心）。
  importance REAL NOT NULL DEFAULT 0.5,
  -- unresolved_threads: 这段没说完的事 / 留下的悬念。JSON string[]，例 ["你妈最后到底有没有原谅你"]
  unresolved_threads_json TEXT NOT NULL DEFAULT '[]',
  -- 时间窗
  time_range_start INTEGER NOT NULL,
  time_range_end INTEGER NOT NULL,
  -- 元数据
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 来源：来自 cron 自动合成、admin 手动建、还是 LLM 推断
  source TEXT NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS idx_narrative_episode_assistant_time
  ON narrative_episode(assistant_id, time_range_end DESC);
CREATE INDEX IF NOT EXISTS idx_narrative_episode_importance
  ON narrative_episode(assistant_id, importance DESC);

-- episode ↔ memory_items 关联（多对多）。
-- 不用 memory_edges：因为两端类型不同（episode vs memory），强行塞进同表会模糊语义。
CREATE TABLE IF NOT EXISTS episode_memory_link (
  episode_id TEXT NOT NULL,
  memory_item_id TEXT NOT NULL,
  -- weight: 0-1，"这条 memory 在这个 episode 里有多核心"
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (episode_id, memory_item_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_memory_link_memory
  ON episode_memory_link(memory_item_id);

-- ── persistent_topic ────────────────────────────────────────────────
--
-- 长期话题：跨多个 episode、贯穿数月的关注点。
-- 例：用户学钢琴半年 → topic="钢琴学习"，status="growing"，trajectory 记录每次 mention。
--
-- status 状态机：
--   growing      最近一周内多次提，正在发展
--   unresolved   悬而未决（用户表达过不安/无解，但还在谈）
--   painful      谈起就疼，但还没回避
--   nostalgic    很久没谈，用户提起带怀念色彩
--   exciting    最近多次正面提及
--   dormant      连续 3 周未提（自动转）
--   resolved     用户明确说"放下了"

CREATE TABLE IF NOT EXISTS persistent_topic (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  -- 标准化后的话题名，例 "钢琴学习" / "和母亲关系" — 不是用户原话
  topic TEXT NOT NULL,
  -- 别名/关键词（提取时匹配用），JSON string[]
  aliases_json TEXT NOT NULL DEFAULT '[]',
  emotional_association TEXT NOT NULL DEFAULT 'neutral',
  -- 状态：见上注释
  status TEXT NOT NULL DEFAULT 'growing',
  -- importance 0-1，决定 prompt 注入优先级
  importance REAL NOT NULL DEFAULT 0.4,
  -- trajectory: 时序数据点，JSON array of {ts, valence, mention_text}
  -- 不上限，但 service 写入时滑动窗口保留最近 N 条
  trajectory_json TEXT NOT NULL DEFAULT '[]',
  first_mentioned_at INTEGER NOT NULL,
  last_discussed_at INTEGER NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_persistent_topic_assistant_status
  ON persistent_topic(assistant_id, status, last_discussed_at DESC);
CREATE INDEX IF NOT EXISTS idx_persistent_topic_assistant_topic
  ON persistent_topic(assistant_id, topic);
CREATE INDEX IF NOT EXISTS idx_persistent_topic_importance
  ON persistent_topic(assistant_id, importance DESC);
