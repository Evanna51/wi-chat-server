/**
 * @typedef {Object} LLMMessage
 * @property {"system"|"user"|"assistant"} role
 * @property {string} content
 */

/**
 * @typedef {Object} CompletionRequest
 * @property {LLMMessage[]} messages
 * @property {number}  [temperature]
 * @property {number}  [maxTokens]
 * @property {"json"|"text"} [responseFormat]  - "json" forces temp=0 and strong JSON constraint
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
   * @returns {Promise<number[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async embed(_text) {
    throw new Error(`${this.name}.embed() not implemented`);
  }

  /** @returns {Promise<boolean>} */
  async healthCheck() {
    return false;
  }
}

module.exports = { ILLMProvider };
