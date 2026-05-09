/**
 * @typedef {Object} LLMMessage
 * @property {"system"|"user"|"assistant"} role
 * @property {string} content
 */

/**
 * @typedef {Object} CallOpts
 * @property {string}   [kind]       callRegistry 分类（"chat_reply" / "reflect" / "memory_classify" / 等）
 * @property {string?}  [scopeKey]   scope，决定 supersede 行为（如 assistantId）
 * @property {string?}  [summary]    debug 描述（admin UI 显示在飞调用时用）
 * @property {boolean?} [supersede]  显式覆盖 KIND_DEFAULTS
 */

/**
 * @typedef {Object} CompletionRequest
 * @property {LLMMessage[]} messages
 * @property {number}  [temperature]
 * @property {number}  [maxTokens]
 * @property {"json"|"text"} [responseFormat]  - "json" forces temp=0 and strong JSON constraint
 * @property {CallOpts} [callOpts]              - 透传给 registeredFetch 用于追踪 / 取消
 */

/**
 * @typedef {Object} CompletionResult
 * @property {string} content          - raw text from model
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {string} [model]
 */

/**
 * ILLMProvider — interface contract for all provider adapters.
 *
 * Implementors must override complete() and embed().
 * healthCheck() is optional.
 */
class ILLMProvider {
  get name() { return "base"; }

  /**
   * @param {CompletionRequest} _req
   * @returns {Promise<CompletionResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async complete(_req) {
    throw new Error(`${this.name}.complete() not implemented`);
  }

  /**
   * @param {string} _text
   * @param {CallOpts} [_callOpts]  可选；用于 callRegistry 追踪
   * @returns {Promise<number[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async embed(_text, _callOpts) {
    throw new Error(`${this.name}.embed() not implemented`);
  }

  /** @returns {Promise<boolean>} */
  async healthCheck() {
    return false;
  }
}

module.exports = { ILLMProvider };
