const { ILLMProvider } = require("./ILLMProvider");

/**
 * FakeProvider — 测试用，可注入预设回答。
 *
 * 用法:
 *   const fake = new FakeProvider();
 *   fake.setResponse('{"ok":true}');
 *   const { _setProviderForTesting } = require('./index');
 *   _setProviderForTesting(fake);
 */
class FakeProvider extends ILLMProvider {
  constructor() {
    super();
    this._responses = [];
    this._callLog = [];
    this._defaultContent = "{}";
    this._defaultVector = new Array(256).fill(0.1);
  }

  get name() { return "fake"; }

  setResponse(content) {
    this._defaultContent = content;
    return this;
  }

  queueResponse(content) {
    this._responses.push(content);
    return this;
  }

  getCallLog() { return this._callLog; }
  resetCallLog() { this._callLog = []; return this; }

  async complete(req) {
    const content = this._responses.length ? this._responses.shift() : this._defaultContent;
    this._callLog.push({ type: "chat", req, content });
    return { content, inputTokens: 10, outputTokens: 5, model: "fake" };
  }

  async embed(text) {
    this._callLog.push({ type: "embed", text });
    return this._defaultVector.slice();
  }

  async healthCheck() { return true; }
}

module.exports = { FakeProvider };
